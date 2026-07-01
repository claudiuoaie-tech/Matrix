import { Router, Request, Response } from "express";
import type { ShiftSlot } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireExternalApiKey } from "../lib/externalAuth";
import { sendSms } from "../lib/twilio";
import { isRtwExpired } from "../lib/rtw";
import { emitRotaEvent } from "../lib/events";
import { dateOnlyUTC, ymdFromUTC, splitName, formatDateUk } from "../lib/board";

export const externalRouter = Router();

// Every route on this gateway requires the external API key (X-API-Key header).
externalRouter.use(requireExternalApiKey);

/** Map a "HH:MM" start time to the coarse shift slot enum. */
function slotFromTime(start: string): ShiftSlot {
  const h = Number(start.split(":")[0]);
  if (Number.isNaN(h)) return "AM";
  if (h < 12) return "AM";
  if (h < 18) return "PM";
  return "NIGHT";
}

/** Naive end time = start + 8h (HH:MM), wrapping at 24h. Used only for SMS copy. */
function plusEightHours(start: string): string {
  const [h, m] = start.split(":").map(Number);
  if (Number.isNaN(h)) return start;
  const end = (h + 8) % 24;
  return `${String(end).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
}

interface PersonRef {
  workerId: string;
  name: string;
  phone: string;
}

// ----------------------------------------------------------------------------
// GET /api/v1/external/workers — structured active worker directory
// ----------------------------------------------------------------------------

externalRouter.get("/workers", async (_req: Request, res: Response): Promise<void> => {
  const workers = await prisma.worker.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      clientPool: true,
      rtwExpiryDate: true,
      skills: true,
    },
  });

  res.json({
    count: workers.length,
    workers: workers.map((w) => {
      const { firstName, lastName } = splitName(w.name);
      return {
        id: w.id,
        firstName,
        lastName,
        fullName: w.name,
        phone: w.phone,
        email: w.email,
        clientPool: w.clientPool,
        skills: w.skills,
        rtw: {
          expiryDate: w.rtwExpiryDate ? ymdFromUTC(new Date(w.rtwExpiryDate)) : null,
          expired: isRtwExpired(w.rtwExpiryDate),
        },
      };
    }),
  });
});

// ----------------------------------------------------------------------------
// POST /api/v1/external/bookings/reconcile — headcount reconciliation
// ----------------------------------------------------------------------------

externalRouter.post(
  "/bookings/reconcile",
  async (req: Request, res: Response): Promise<void> => {
    const clientName = String(req.body?.clientName ?? "").trim();
    const targetHeadcount = Number(req.body?.targetHeadcount);
    const shiftDate = String(req.body?.shiftDate ?? "").trim();
    const startTime = String(req.body?.startTime ?? "").trim();
    const section = req.body?.section != null ? String(req.body.section).trim() : "";

    if (!clientName) {
      res.status(400).json({ error: "clientName is required" });
      return;
    }
    if (!Number.isInteger(targetHeadcount) || targetHeadcount < 0) {
      res.status(400).json({ error: "targetHeadcount must be a non-negative integer" });
      return;
    }
    const dateObj = new Date(`${shiftDate}T00:00:00.000Z`);
    if (!shiftDate || Number.isNaN(dateObj.getTime())) {
      res.status(400).json({ error: "shiftDate must be a valid YYYY-MM-DD date" });
      return;
    }
    if (!startTime) {
      res.status(400).json({ error: "startTime is required" });
      return;
    }

    const client = await prisma.client.findFirst({
      where: { companyName: clientName, status: "ACTIVE" },
    });
    if (!client) {
      res.status(404).json({ error: `No active client named "${clientName}"` });
      return;
    }

    const date = dateOnlyUTC(shiftDate);
    const dateLabel = formatDateUk(date);

    // Current scheduled headcount for this client/day.
    const scheduled = await prisma.rotaCell.findMany({
      where: { clientId: client.id, date, status: "SCHEDULED" },
      include: { worker: { select: { id: true, name: true, phone: true } } },
    });
    const scheduledCount = scheduled.length;

    const cancellationsTriggered: PersonRef[] = [];
    const invitesSent: PersonRef[] = [];
    let status: "balanced" | "over_staffed" | "under_staffed" = "balanced";

    if (scheduledCount > targetHeadcount) {
      // ---- Over-staffed: cancel the surplus (pending/unconfirmed first) ----
      status = "over_staffed";
      const surplus = scheduledCount - targetHeadcount;
      const ordered = [...scheduled].sort(
        (a, b) => Number(a.confirmed) - Number(b.confirmed)
      );
      const toCancel = ordered.slice(0, surplus);

      // Flip them all to CANCELLED atomically (prevents races where two
      // reconciliations cancel overlapping sets).
      await prisma.$transaction(
        toCancel.map((c) =>
          prisma.rotaCell.update({
            where: { id: c.id },
            data: { status: "CANCELLED", confirmed: false, startTime: null, endTime: null },
          })
        )
      );

      // Notify each affected worker (established cancellation SMS) + emit events.
      for (const c of toCancel) {
        const first = splitName(c.worker.name).firstName;
        await sendSms(
          c.worker.phone,
          `Hi ${first}, your shift on ${dateLabel} at ${client.companyName} has been cancelled.`
        );
        cancellationsTriggered.push({
          workerId: c.worker.id,
          name: c.worker.name,
          phone: c.worker.phone,
        });
        emitRotaEvent({
          type: "board.updated",
          payload: { workerId: c.worker.id, date: shiftDate, state: "CANCELLED" },
        });
      }
    } else if (scheduledCount < targetHeadcount) {
      // ---- Under-staffed: invite blank/AVAILABLE workers to fill the deficit ----
      status = "under_staffed";
      const deficit = targetHeadcount - scheduledCount;

      // Workers on holiday that day are never eligible.
      const onHoliday = new Set(
        (
          await prisma.holidayRequest.findMany({
            where: {
              status: { in: ["PENDING", "APPROVED"] },
              startDate: { lte: date },
              endDate: { gte: date },
            },
            select: { workerId: true },
          })
        ).map((h) => h.workerId)
      );

      const poolWorkers = await prisma.worker.findMany({
        where: { status: "ACTIVE", clientPool: client.pool, deletedAt: null },
        orderBy: { name: "asc" },
      });
      const poolIds = poolWorkers.map((w) => w.id);
      const cells = await prisma.rotaCell.findMany({
        where: { workerId: { in: poolIds }, date },
      });
      const cellByWorker = new Map(cells.map((c) => [c.workerId, c]));

      // Eligible = active, RTW valid, not on holiday, and blank or AVAILABLE today.
      const candidates = poolWorkers
        .filter((w) => !onHoliday.has(w.id) && !isRtwExpired(w.rtwExpiryDate))
        .filter((w) => {
          const cell = cellByWorker.get(w.id);
          return !cell || cell.status === "AVAILABLE";
        })
        .slice(0, deficit);

      if (candidates.length > 0) {
        // Find or create the shift the invites attach to so a "1" reply flows
        // through the established SMS-accept loop and lands on the board.
        let shift = await prisma.shift.findFirst({
          where: { clientId: client.id, date, startTime },
        });
        if (!shift) {
          shift = await prisma.shift.create({
            data: {
              clientId: client.id,
              date,
              slot: slotFromTime(startTime),
              startTime,
              endTime: plusEightHours(startTime),
              slotsNeeded: targetHeadcount,
            },
          });
        } else if (shift.slotsNeeded < targetHeadcount) {
          shift = await prisma.shift.update({
            where: { id: shift.id },
            data: { slotsNeeded: targetHeadcount },
          });
        }
        const shiftId = shift.id;

        // Seed PROPOSED allocations atomically.
        await prisma.$transaction(
          candidates.map((w) =>
            prisma.allocation.upsert({
              where: { shiftId_workerId: { shiftId, workerId: w.id } },
              create: { shiftId, workerId: w.id, state: "PROPOSED" },
              update: { state: "PROPOSED" },
            })
          )
        );

        // Fire the Shift Invite text to each candidate.
        for (const w of candidates) {
          const first = splitName(w.name).firstName;
          await sendSms(
            w.phone,
            `Hi ${first}, shift opportunity at ${client.companyName} on ${dateLabel} from ${startTime}${
              section ? ` (${section})` : ""
            }. Reply 1 to accept or 2 to decline.`
          );
          invitesSent.push({ workerId: w.id, name: w.name, phone: w.phone });
          emitRotaEvent({
            type: "allocation.created",
            payload: { shiftId, workerId: w.id, state: "PROPOSED" },
          });
        }
      }
    }

    res.json({
      status,
      scheduledCount,
      targetHeadcount,
      cancellationsTriggered,
      invitesSent,
    });
  }
);
