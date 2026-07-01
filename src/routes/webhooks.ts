import { Router, Request, Response } from "express";
import twilio from "twilio";
import type { MessageChannel } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { validateTwilioSignature } from "../middleware/validateTwilioSignature";
import { acceptAllocation, declineAllocation } from "../lib/allocations";
import { emitRotaEvent } from "../lib/events";
import { ymdFromUTC, dateOnlyUTC, formatDateUk } from "../lib/board";
import { fireWebhook } from "../services/webhook.service";

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

/** The WhatsApp customer-care window is 24 hours from the contact's last reply. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * (Re)open the 24h WhatsApp window for a phone number on inbound reply. Upserts
 * a WhatsappContact keyed by phone. Best-effort — a failure here must never
 * block the worker's reply, so errors are swallowed.
 */
async function touchWhatsappWindow(phone: string): Promise<void> {
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + WHATSAPP_WINDOW_MS);
    await prisma.whatsappContact.upsert({
      where: { phone },
      create: { phone, windowExpiresAt: expires, lastInboundAt: now },
      update: { windowExpiresAt: expires, lastInboundAt: now },
    });
  } catch (err) {
    console.error("[whatsapp window] failed to update contact window:", err);
  }
}

/**
 * True if the reply is an acceptance: "1", "yes", "y", "ok"/"okay", or "confirm"
 * (case-insensitive), matched on word boundaries so "y" / "n" only fire when they
 * stand alone.
 */
function isAffirmative(body: string): boolean {
  return /\b(1|y|yes|ok|okay|confirm|confirmed)\b/i.test(body);
}

/**
 * True if the reply is a rejection: "2", "no", "n", "reject", or "not available"
 * (case-insensitive).
 */
function isNegative(body: string): boolean {
  return /\b(2|n|no|reject|rejected)\b/i.test(body) || /\bnot\s+available\b/i.test(body);
}

/** Confirmation reply sent when a worker accepts. */
const CONFIRM_REPLY = "Thank you. Your shift has been locked in and confirmed.";
/** Reply sent when a worker rejects. */
const REJECT_REPLY =
  "Thank you for letting us know. We have removed you from this shift request.";
/** Reply sent when a worker cancels a shift they had already confirmed. */
const CANCELLATION_REPLY =
  "We have processed your cancellation and removed you from this shift. Thank you for letting us know.";

/** The pending board cell we can action from an inbound reply. */
type PendingCell = { id: string; workerId: string; date: Date };

/**
 * The worker's most relevant pending board shift: a SCHEDULED cell not yet
 * confirmed, dated today or later. This is how a shift allocated directly on the
 * rota board (which writes a RotaCell, not an Allocation) is confirmed/rejected
 * over SMS. Soonest upcoming shift wins.
 */
async function findPendingCell(workerId: string): Promise<PendingCell | null> {
  const today = dateOnlyUTC(ymdFromUTC(new Date()));
  return prisma.rotaCell.findFirst({
    where: { workerId, status: "SCHEDULED", confirmed: false, date: { gte: today } },
    orderBy: [{ date: "asc" }, { updatedAt: "desc" }],
    select: { id: true, workerId: true, date: true },
  });
}

/**
 * Confirm a pending board cell: flip `confirmed` true (this drives the green dot
 * + double-tick marker on the board) and push a real-time board update.
 */
async function confirmPendingCell(cell: PendingCell): Promise<void> {
  await prisma.rotaCell.update({ where: { id: cell.id }, data: { confirmed: true } });
  emitRotaEvent({
    type: "board.updated",
    payload: { workerId: cell.workerId, date: ymdFromUTC(cell.date) },
  });
}

/**
 * Reject a pending board cell: move it out of the active shift cartridge into the
 * REJECTED cartridge (freeing the slot) and push a real-time board update.
 */
async function rejectPendingCell(cell: PendingCell): Promise<void> {
  await prisma.rotaCell.update({
    where: { id: cell.id },
    data: { status: "REJECTED", confirmed: false, startTime: null, endTime: null },
  });
  emitRotaEvent({
    type: "board.updated",
    payload: { workerId: cell.workerId, date: ymdFromUTC(cell.date) },
  });
}

/**
 * The worker's soonest upcoming shift that they had ALREADY confirmed (SCHEDULED
 * + confirmed, dated today or later). Used to catch a late cancellation — a
 * rejection that arrives after the worker locked the shift in.
 */
async function findConfirmedUpcomingCell(workerId: string): Promise<PendingCell | null> {
  const today = dateOnlyUTC(ymdFromUTC(new Date()));
  return prisma.rotaCell.findFirst({
    where: { workerId, status: "SCHEDULED", confirmed: true, date: { gte: today } },
    orderBy: [{ date: "asc" }, { updatedAt: "desc" }],
    select: { id: true, workerId: true, date: true },
  });
}

/**
 * Process a LATE cancellation: a worker who had already confirmed an upcoming
 * shift now backs out. Move the cell into the REJECTED cartridge (reopening the
 * slot), push a real-time board update, raise a high-visibility "⚠️ CANCELLATION"
 * alert in the conversation thread (unread, so the Live Inbox badge fires), and
 * fan the event out to the internal webhook — so the team notices immediately
 * that a locked-in worker has dropped out.
 */
async function cancelConfirmedCell(
  cell: PendingCell,
  worker: { id: string; name: string },
  fromNumber: string,
  channel: MessageChannel
): Promise<void> {
  await prisma.rotaCell.update({
    where: { id: cell.id },
    data: { status: "REJECTED", confirmed: false, startTime: null, endTime: null },
  });
  emitRotaEvent({
    type: "board.updated",
    payload: { workerId: cell.workerId, date: ymdFromUTC(cell.date) },
  });

  // Tag the thread + drive the unread badge. Best-effort: a logging failure must
  // never block the reply to the worker.
  const dateLabel = formatDateUk(cell.date);
  try {
    const alert = await prisma.incomingMessage.create({
      data: {
        fromNumber,
        messageBody: `⚠️ CANCELLATION: ${worker.name} has cancelled a CONFIRMED shift on ${dateLabel}. The slot has been reopened.`,
        channel,
        workerId: worker.id,
        // direction defaults INBOUND, isRead defaults false — deliberately left
        // unread so it lights up the Live Inbox unread badge.
      },
    });
    emitRotaEvent({
      type: "message.received",
      payload: {
        id: alert.id,
        fromNumber: alert.fromNumber,
        messageBody: alert.messageBody,
        channel: alert.channel,
        mediaUrl: alert.mediaUrl,
        receivedAt: alert.receivedAt.toISOString(),
        isRead: alert.isRead,
        workerName: worker.name,
      },
    });
  } catch (err) {
    console.error("[cancellation alert] failed to tag thread:", err);
  }

  // Internal admin / HR system alert (fire-and-forget).
  void fireWebhook("shift.cancelled", {
    workerId: worker.id,
    workerName: worker.name,
    phone: fromNumber,
    date: ymdFromUTC(cell.date),
  });
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
      // Trace exactly which keys Twilio sends (body for POST, query for GET).
      console.log("Twilio Webhook Payload:", req.body);

      const { channel, number: from } = parseSender(
        String(req.body?.From ?? req.query?.From ?? "")
      );
      const body = String(req.body?.Body ?? req.query?.Body ?? "").trim();
      // First media attachment, if any (MMS / WhatsApp photo). Twilio sends
      // MediaUrl0..N; we capture the first, reading body (POST) or query (GET).
      const mediaUrl =
        String(req.body?.MediaUrl0 ?? req.query?.MediaUrl0 ?? "").trim() || null;

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

      // A WhatsApp reply (re)opens the 24h customer-care window for this contact,
      // during which the admin may free-text them. Tracked per phone so it also
      // covers cold recruits with no Worker record. Best-effort.
      if (channel === "WHATSAPP") {
        await touchWhatsappWindow(from);
      }

      // Unknown sender, or worker not eligible to respond -> safe no-op.
      if (!worker || worker.status === "INACTIVE" || worker.status === "SUSPENDED") {
        replyEmpty(res);
        return;
      }

      // 2. Parse the reply intent. Accept: 1 / yes / y / ok / confirm. Reject:
      //    2 / no / n / reject / not available. We only act on a CLEAR single
      //    intent (exactly one of the two) — a contradictory or empty reply is
      //    treated as ordinary chatter and logged quietly.
      const accept = isAffirmative(body);
      const decline = isNegative(body);
      const clearIntent = accept !== decline;

      // 3. Prefer a live PROPOSED allocation (the SMS-invite / broadcast flow),
      //    which routes through the transactional accept/decline helpers (they
      //    also reflect onto the board cell).
      const allocation = await prisma.allocation.findFirst({
        where: { workerId: worker.id, state: "PROPOSED" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, shiftId: true },
      });

      if (allocation && clearIntent) {
        if (accept) {
          await handleAccept(res, allocation.id, allocation.shiftId);
          return;
        }
        await declineAllocation(allocation.id, allocation.shiftId);
        replyTwiml(res, REJECT_REPLY);
        return;
      }

      // 4. Otherwise action a pending board shift allocated directly on the rota
      //    (a SCHEDULED, not-yet-confirmed cell — no Allocation row). Accept flips
      //    the confirmation marker; reject drops it into the REJECTED cartridge.
      if (!allocation && clearIntent) {
        const cell = await findPendingCell(worker.id);
        if (cell) {
          if (accept) {
            await confirmPendingCell(cell);
            replyTwiml(res, CONFIRM_REPLY);
            return;
          }
          await rejectPendingCell(cell);
          replyTwiml(res, REJECT_REPLY);
          return;
        }
      }

      // 5. Late cancellation: a rejection with no pending shift left, but the
      //    worker had already CONFIRMED an upcoming shift. Drop it into the
      //    REJECTED cartridge, alert admins (a locked-in worker has pulled out),
      //    and acknowledge the cancellation.
      if (!allocation && decline && !accept) {
        const confirmedCell = await findConfirmedUpcomingCell(worker.id);
        if (confirmedCell) {
          await cancelConfirmedCell(
            confirmedCell,
            { id: worker.id, name: worker.name },
            from,
            channel
          );
          replyTwiml(res, CANCELLATION_REPLY);
          return;
        }
      }

      // 6. No actionable pending shift, or an ambiguous / casual reply ("thanks",
      //    a question, a keyword with nothing to confirm): the message is already
      //    logged to the thread above — stay silent so an admin can reply by hand.
      replyEmpty(res);
    } catch (err) {
      console.error("[twilio webhook] error:", err);
      // Avoid leaking internals; Twilio will treat a 500 as a failed delivery.
      res.status(500).send("Internal error");
    }
  }
);

/**
 * POST /api/webhooks/twilio/status
 *
 * Delivery status callback. messages.create only reports the INITIAL state
 * (queued/accepted); the real outcome — delivered, or undelivered/failed with
 * an ErrorCode — lands here moments later. This is what reveals WhatsApp 63016
 * ("free-form message outside the 24h window — use a template"), the usual
 * reason a business-initiated message is accepted but never received.
 *
 * Log-only: no DB writes, no state change, so it stays a pure diagnostic.
 */
webhooksRouter.post(
  "/twilio/status",
  validateTwilioSignature,
  (req: Request, res: Response): void => {
    const b = req.body ?? {};
    const status = String(b.MessageStatus ?? b.SmsStatus ?? "");
    const sid = String(b.MessageSid ?? b.SmsSid ?? "");
    const to = String(b.To ?? "");
    const errorCode = b.ErrorCode ? String(b.ErrorCode) : "";
    const line = `[delivery] sid=${sid} status=${status} to=${to}${
      errorCode ? ` errorCode=${errorCode}` : ""
    }`;
    if (status === "undelivered" || status === "failed" || errorCode) {
      console.error(line, b.ErrorMessage ? `errorMessage=${b.ErrorMessage}` : "");
    } else {
      console.log(line);
    }
    res.sendStatus(204);
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
    replyTwiml(res, CONFIRM_REPLY);
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
