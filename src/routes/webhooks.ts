import { Router, Request, Response } from "express";
import twilio from "twilio";
import type { MessageChannel } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { validateTwilioSignature } from "../middleware/validateTwilioSignature";
import { acceptAllocation, declineAllocation } from "../lib/allocations";
import { emitRotaEvent } from "../lib/events";

export const webhooksRouter = Router();

const { MessagingResponse } = twilio.twiml;

/**
 * Normalise a phone number to a comparable form. Twilio sends E.164 (e.g.
 * "+447700900123"); we strip spaces just in case a stored number differs.
 */
function normalisePhone(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

/**
 * Parse Twilio's `From` into a channel + bare E.164 number. WhatsApp arrives
 * prefixed ("whatsapp:+447700900123"); SMS arrives as a plain number.
 */
function parseSender(raw: string): { channel: MessageChannel; number: string } {
  const t = raw.trim();
  if (/^whatsapp:/i.test(t)) {
    return { channel: "WHATSAPP", number: normalisePhone(t.replace(/^whatsapp:/i, "")) };
  }
  return { channel: "SMS", number: normalisePhone(t) };
}

/**
 * Persist an inbound message to the Live Inbox and push a real-time event to
 * connected admin dashboards. Best-effort: a logging failure must never block
 * the worker's reply, so errors are swallowed.
 */
async function logIncoming(
  fromNumber: string,
  messageBody: string,
  channel: MessageChannel,
  worker: { id: string; name: string } | null,
  mediaUrl: string | null
): Promise<void> {
  try {
    const msg = await prisma.incomingMessage.create({
      data: { fromNumber, messageBody, channel, workerId: worker?.id ?? null, mediaUrl },
    });
    emitRotaEvent({
      type: "message.received",
      payload: {
        id: msg.id,
        fromNumber: msg.fromNumber,
        messageBody: msg.messageBody,
        channel: msg.channel,
        mediaUrl: msg.mediaUrl,
        receivedAt: msg.receivedAt.toISOString(),
        isRead: msg.isRead,
        workerName: worker?.name ?? null,
      },
    });
  } catch (err) {
    console.error("[inbox] failed to log inbound message:", err);
  }
}

/** True if the reply contains an accept signal: a standalone "1" or "YES". */
function isAffirmative(body: string): boolean {
  return /\b1\b/.test(body) || /\byes\b/i.test(body);
}

/** True if the reply contains a decline signal: a standalone "2" or "NO". */
function isNegative(body: string): boolean {
  return /\b2\b/.test(body) || /\bno\b/i.test(body);
}

/** Build a TwiML response containing a single SMS reply and send it. */
function replyTwiml(res: Response, message: string): void {
  const twiml = new MessagingResponse();
  twiml.message(message);
  res.type("text/xml").send(twiml.toString());
}

/** Acknowledge to Twilio without sending any reply SMS. */
function replyEmpty(res: Response): void {
  const twiml = new MessagingResponse();
  res.type("text/xml").send(twiml.toString());
}

/**
 * POST /api/webhooks/twilio
 *
 * Processes inbound SMS replies from temporary workers responding to shift
 * proposals. Workers reply "1" to accept or "2" to decline the most recent
 * proposal sent to them.
 */
webhooksRouter.post(
  "/twilio",
  validateTwilioSignature,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { channel, number: from } = parseSender(String(req.body?.From ?? ""));
      const body = String(req.body?.Body ?? "").trim();
      // First media attachment, if any (MMS / WhatsApp photo). Twilio sends
      // MediaUrl0..N; we capture the first.
      const mediaUrl = String(req.body?.MediaUrl0 ?? "").trim() || null;

      if (!from) {
        replyEmpty(res);
        return;
      }

      // 1. Phone number lookup.
      const worker = await prisma.worker.findUnique({
        where: { phone: from },
      });

      // Log EVERY inbound message to the Live Inbox first — whether or not it
      // matches a worker or an automated command — then carry on with the
      // scheduling flow below.
      await logIncoming(
        from,
        body,
        channel,
        worker ? { id: worker.id, name: worker.name } : null,
        mediaUrl
      );

      // Unknown sender, or worker not eligible to respond -> safe no-op.
      if (!worker || worker.status === "INACTIVE" || worker.status === "SUSPENDED") {
        replyEmpty(res);
        return;
      }

      // 2. Find the most recent PROPOSED allocation for this worker.
      const allocation = await prisma.allocation.findFirst({
        where: { workerId: worker.id, state: "PROPOSED" },
        orderBy: { updatedAt: "desc" },
        include: { shift: true },
      });

      if (!allocation) {
        replyTwiml(
          res,
          "We couldn't find an open shift offer for you right now. We'll be in touch when the next one comes up."
        );
        return;
      }

      // 3. Parse the reply. A message COUNTS as an accept if it contains "1" or
      //    "YES", and as a decline if it contains "2" or "NO" (case-insensitive),
      //    so "1", "yes please", "2 sorry", "no can do" all work.
      const accept = isAffirmative(body);
      const decline = isNegative(body);

      if (accept && !decline) {
        await handleAccept(res, allocation.id, allocation.shiftId);
        return;
      }

      if (decline && !accept) {
        await declineAllocation(allocation.id, allocation.shiftId);
        replyTwiml(
          res,
          "Thanks for letting us know — we've recorded that you're not available for this shift. We'll keep you posted on future work."
        );
        return;
      }

      // Nothing matched, or the reply was contradictory (both yes and no) —
      // guide the worker to a clear answer.
      replyTwiml(
        res,
        "Sorry, we didn't understand that. Reply 1 (or YES) to ACCEPT the offered shift, or 2 (or NO) to DECLINE."
      );
    } catch (err) {
      console.error("[twilio webhook] error:", err);
      // Avoid leaking internals; Twilio will treat a 500 as a failed delivery.
      res.status(500).send("Internal error");
    }
  }
);

/**
 * Handle an acceptance via the shared allocation helper (transactional slot
 * re-check + real-time event emission), then reply over SMS.
 */
async function handleAccept(
  res: Response,
  allocationId: string,
  shiftId: string
): Promise<void> {
  const outcome = await acceptAllocation(allocationId, shiftId);

  if (outcome === "CONFIRMED") {
    replyTwiml(
      res,
      "You're confirmed for the shift — thank you! We'll send the full details shortly. See you there."
    );
    return;
  }

  if (outcome === "FULL") {
    replyTwiml(
      res,
      "Thanks for your reply! Unfortunately this shift has just been filled. Stay tuned — we'll let you know as soon as another opening comes up."
    );
    return;
  }

  if (outcome === "EXPIRED") {
    replyTwiml(
      res,
      "Action required: Your onboarding documentation has expired. Please contact management to update your profile."
    );
    return;
  }

  // Shift no longer exists.
  replyTwiml(
    res,
    "Sorry, that shift is no longer available. We'll be in touch with the next opportunity."
  );
}
