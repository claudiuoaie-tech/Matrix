import { Router, Request, Response } from "express";
import type { RotaStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireWorker } from "../lib/auth";
import { acceptAllocation, declineAllocation } from "../lib/allocations";
import { emitRotaEvent } from "../lib/events";
import { fireWebhook } from "../services/webhook.service";
import { mondayKey, windowKeys, dateOnlyUTC, ymdFromUTC } from "../lib/board";

export const workerRouter = Router();

// Statuses a worker may set on themselves via self-service. The rest
// (SCHEDULED / CANCELLED / NO_SHOW) are admin-driven only.
const WORKER_SETTABLE: RotaStatus[] = [
  "AVAILABLE",
  "UNAVAILABLE",
  "SICK",
  "REST",
  "HOLIDAY",
];

// Every route here requires an authenticated, active worker.
workerRouter.use(requireWorker);

/** GET /api/worker/me — current worker profile. */
workerRouter.get("/me", (req: Request, res: Response): void => {
  const w = req.worker!;
  res.json({
    id: w.id,
    name: w.name,
    phone: w.phone,
    status: w.status,
    clientPool: w.clientPool,
  });
});

/** GET /api/worker/availability — the worker's weekly availability matrix. */
workerRouter.get("/availability", async (req: Request, res: Response): Promise<void> => {
  const rows = await prisma.availability.findMany({
    where: { workerId: req.worker!.id },
  });
  res.json(
    rows.map((r) => ({ dayOfWeek: r.dayOfWeek, slot: r.slot, available: r.available }))
  );
});

/**
 * PUT /api/worker/availability
 * Body: { availability: [{ dayOfWeek: 0-6, slot: "AM"|"PM"|"NIGHT", available }] }
 * Upserts each cell of the weekly grid.
 */
workerRouter.put("/availability", async (req: Request, res: Response): Promise<void> => {
  const workerId = req.worker!.id;
  const items = Array.isArray(req.body?.availability) ? req.body.availability : [];

  const valid = items.filter(
    (i: { dayOfWeek?: number; slot?: string }) =>
      typeof i?.dayOfWeek === "number" &&
      i.dayOfWeek >= 0 &&
      i.dayOfWeek <= 6 &&
      ["AM", "PM", "NIGHT"].includes(String(i?.slot))
  );

  await prisma.$transaction(
    valid.map((i: { dayOfWeek: number; slot: "AM" | "PM" | "NIGHT"; available: boolean }) =>
      prisma.availability.upsert({
        where: {
          workerId_dayOfWeek_slot: {
            workerId,
            dayOfWeek: i.dayOfWeek,
            slot: i.slot,
          },
        },
        create: {
          workerId,
          dayOfWeek: i.dayOfWeek,
          slot: i.slot,
          available: Boolean(i.available),
        },
        update: { available: Boolean(i.available) },
      })
    )
  );

  emitRotaEvent({
    type: "availability.updated",
    payload: { workerId },
  });

  res.json({ ok: true, saved: valid.length });
});

/** GET /api/worker/schedule — upcoming shifts the worker has been allocated. */
workerRouter.get("/schedule", async (req: Request, res: Response): Promise<void> => {
  const allocations = await prisma.allocation.findMany({
    where: {
      workerId: req.worker!.id,
      state: { in: ["PROPOSED", "CONFIRMED", "DECLINED"] },
      shift: { date: { gte: startOfToday() } },
    },
    include: { shift: { include: { client: true } } },
    orderBy: { shift: { date: "asc" } },
  });

  res.json(
    allocations.map((a) => ({
      allocationId: a.id,
      state: a.state,
      shift: {
        id: a.shift.id,
        date: a.shift.date,
        slot: a.shift.slot,
        startTime: a.shift.startTime,
        endTime: a.shift.endTime,
        client: a.shift.client.companyName,
      },
    }))
  );
});

/**
 * GET /api/worker/shifts — the worker's upcoming CONFIRMED shifts straight from
 * the planning board (RotaCell). Covers both admin-set shifts and SMS/in-app
 * acceptances, since both write a SCHEDULED cell. Scoped to the authenticated
 * worker's id, so a worker only ever sees their own bookings.
 */
workerRouter.get("/shifts", async (req: Request, res: Response): Promise<void> => {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const todayKey = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;

  const cells = await prisma.rotaCell.findMany({
    where: {
      workerId: req.worker!.id,
      status: "SCHEDULED",
      date: { gte: dateOnlyUTC(todayKey) },
    },
    orderBy: { date: "asc" },
    include: { client: { select: { companyName: true } } },
  });

  res.json(
    cells.map((c) => ({
      id: c.id,
      date: ymdFromUTC(c.date),
      startTime: c.startTime,
      endTime: c.endTime,
      label: c.label,
      client: c.client?.companyName ?? null,
    }))
  );
});

/**
 * POST /api/worker/allocations/:id/respond
 * Body: { action: "accept" | "decline" }
 * Mirror of the SMS reply flow for the in-app schedule tab.
 */
workerRouter.post(
  "/allocations/:id/respond",
  async (req: Request, res: Response): Promise<void> => {
    const action = String(req.body?.action ?? "").toLowerCase();
    const allocation = await prisma.allocation.findFirst({
      where: { id: req.params.id, workerId: req.worker!.id },
    });

    if (!allocation) {
      res.status(404).json({ error: "Allocation not found" });
      return;
    }
    if (allocation.state !== "PROPOSED") {
      res.status(409).json({ error: `Allocation is already ${allocation.state}` });
      return;
    }

    if (action === "accept") {
      const outcome = await acceptAllocation(allocation.id, allocation.shiftId);
      if (outcome === "EXPIRED") {
        res.status(403).json({
          error:
            "Your onboarding documentation has expired. Please contact management to update your profile.",
        });
        return;
      }
      res.json({ ok: true, state: outcome === "CONFIRMED" ? "CONFIRMED" : "TIMEOUT", outcome });
      return;
    }
    if (action === "decline") {
      await declineAllocation(allocation.id, allocation.shiftId);
      res.json({ ok: true, state: "DECLINED" });
      return;
    }

    res.status(400).json({ error: "action must be 'accept' or 'decline'" });
  }
);

/** GET /api/worker/holidays — the worker's holiday/absence requests. */
workerRouter.get("/holidays", async (req: Request, res: Response): Promise<void> => {
  const rows = await prisma.holidayRequest.findMany({
    where: { workerId: req.worker!.id },
    orderBy: { startDate: "asc" },
  });
  res.json(rows);
});

/**
 * POST /api/worker/holidays
 * Body: { startDate, endDate, note? }
 * Lands as PENDING; overlapping dates exclude the worker from broadcasts.
 */
workerRouter.post("/holidays", async (req: Request, res: Response): Promise<void> => {
  const workerId = req.worker!.id;
  const start = new Date(String(req.body?.startDate ?? ""));
  const end = new Date(String(req.body?.endDate ?? ""));
  const note = req.body?.note != null ? String(req.body.note).trim() : "";

  const MAX_DAYS = 90;
  const MAX_NOTE = 280;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: "startDate and endDate must be valid dates" });
    return;
  }
  if (end < start) {
    res.status(400).json({ error: "End date must be on or after the start date." });
    return;
  }

  // Strict 7-day notice: the first day of the holiday must be at least 7 full
  // days after the submission date (compared at UTC midnight, matching @db.Date
  // parsing). This also covers past / too-soon dates.
  const today = new Date();
  const todayUTC = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const minStart = new Date(todayUTC.getTime() + 7 * 86_400_000);
  if (start < minStart) {
    res.status(400).json({ error: "Any holiday request must be made at least 7 days in advance" });
    return;
  }

  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_DAYS) {
    res.status(400).json({ error: `A request can't exceed ${MAX_DAYS} days.` });
    return;
  }

  if (note.length > MAX_NOTE) {
    res.status(400).json({ error: `Reason must be ${MAX_NOTE} characters or fewer.` });
    return;
  }

  // Block requests that overlap an existing active (pending/approved) request.
  const clash = await prisma.holidayRequest.findFirst({
    where: {
      workerId,
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: end },
      endDate: { gte: start },
    },
  });
  if (clash) {
    res.status(409).json({ error: "These dates overlap an existing request." });
    return;
  }

  const holiday = await prisma.holidayRequest.create({
    data: {
      workerId,
      startDate: start,
      endDate: end,
      note: note || null,
    },
  });

  emitRotaEvent({
    type: "holiday.requested",
    payload: {
      holidayId: holiday.id,
      workerId: req.worker!.id,
      workerName: req.worker!.name,
      startDate: ymdFromUTC(new Date(holiday.startDate)),
      endDate: ymdFromUTC(new Date(holiday.endDate)),
      reason: holiday.note,
      status: holiday.status,
    },
  });

  // Critical event fan-out: external HR sheets sync new holiday requests.
  void fireWebhook("holiday.requested", {
    workerId: req.worker!.id,
    workerName: req.worker!.name,
    holidayId: holiday.id,
    startDate: ymdFromUTC(new Date(holiday.startDate)),
    endDate: ymdFromUTC(new Date(holiday.endDate)),
    status: holiday.status,
    note: holiday.note,
  });

  res.status(201).json(holiday);
});

/**
 * DELETE /api/worker/holidays/:id — withdraw the worker's own holiday request.
 * Allowed for a PENDING request (cancels it before a decision) or an APPROVED one
 * (cancels the holiday and frees the calendar by clearing its HOLIDAY blocks).
 * The request row is removed either way. Notifies admins so their list/badge sync.
 */
workerRouter.delete("/holidays/:id", async (req: Request, res: Response): Promise<void> => {
  const workerId = req.worker!.id;
  const holiday = await prisma.holidayRequest.findUnique({ where: { id: req.params.id } });
  if (!holiday || holiday.workerId !== workerId) {
    res.status(404).json({ error: "Holiday request not found" });
    return;
  }

  let freedCalendar = false;
  // An approved holiday put HOLIDAY blocks on the board — remove them so the
  // worker is bookable again.
  if (holiday.status === "APPROVED") {
    const DAY = 86_400_000;
    const first = dateOnlyUTC(ymdFromUTC(new Date(holiday.startDate))).getTime();
    const last = dateOnlyUTC(ymdFromUTC(new Date(holiday.endDate))).getTime();
    const dates: Date[] = [];
    for (let t = first, i = 0; t <= last && i < 400; t += DAY, i++) {
      dates.push(new Date(t));
    }
    await prisma.rotaCell.deleteMany({
      where: { workerId, date: { in: dates }, status: "HOLIDAY" },
    });
    freedCalendar = true;
  }

  await prisma.holidayRequest.delete({ where: { id: holiday.id } });

  emitRotaEvent({
    type: "holiday.updated",
    payload: { holidayId: holiday.id, workerId, status: "WITHDRAWN" },
  });
  if (freedCalendar) {
    emitRotaEvent({ type: "board.updated", payload: { workerId } });
  }

  res.json({ ok: true });
});

/**
 * GET /api/worker/board?start=YYYY-MM-DD
 * The worker's own 14-day status cells (Monday-anchored).
 */
workerRouter.get("/board", async (req: Request, res: Response): Promise<void> => {
  const startKey = mondayKey(
    typeof req.query.start === "string" ? req.query.start : undefined
  );
  const keys = windowKeys(startKey, 15);
  const days = keys.slice(0, 14);
  const start = dateOnlyUTC(days[0]);
  const end = dateOnlyUTC(keys[14]);

  const cells = await prisma.rotaCell.findMany({
    where: { workerId: req.worker!.id, date: { gte: start, lt: end } },
  });

  const map: Record<
    string,
    { status: RotaStatus; startTime: string | null; label: string | null }
  > = {};
  for (const c of cells) {
    map[ymdFromUTC(c.date)] = { status: c.status, startTime: c.startTime, label: c.label };
  }

  res.json({ startDate: days[0], days, cells: map });
});

/**
 * PUT /api/worker/board/cell — set the worker's own status for a day.
 * Body: { date, status }  (status limited to the self-service set)
 */
workerRouter.put("/board/cell", async (req: Request, res: Response): Promise<void> => {
  const dateStr = String(req.body?.date ?? "");
  const status = req.body?.status as RotaStatus;

  if (!dateStr) {
    res.status(400).json({ error: "date is required" });
    return;
  }
  if (!WORKER_SETTABLE.includes(status)) {
    res.status(403).json({
      error: "You can only set AVAILABLE, UNAVAILABLE, SICK, REST or HOLIDAY",
    });
    return;
  }

  const date = dateOnlyUTC(dateStr);

  // Availability can be set up to 8 weeks ahead — matches the portal window and
  // keeps future rows bounded.
  const MAX_AHEAD_DAYS = 56;
  const todayUTC = dateOnlyUTC(ymdFromUTC(new Date()));
  const maxDate = new Date(todayUTC.getTime() + MAX_AHEAD_DAYS * 86_400_000);
  if (date > maxDate) {
    res.status(400).json({ error: "You can only set your availability up to 8 weeks ahead." });
    return;
  }

  const workerId = req.worker!.id;
  const cell = await prisma.rotaCell.upsert({
    where: { workerId_date: { workerId, date } },
    create: { workerId, date, status },
    update: { status, label: null, startTime: null, endTime: null, clientId: null },
  });

  emitRotaEvent({ type: "board.updated", payload: { workerId, date: dateStr } });
  res.json(cell);
});

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
