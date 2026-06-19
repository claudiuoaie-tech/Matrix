import { prisma } from "./prisma";
import { emitRotaEvent } from "./events";
import { dateOnlyUTC, ymdFromUTC } from "./board";
import { isRtwExpired } from "./rtw";

export type AcceptOutcome = "CONFIRMED" | "FULL" | "MISSING" | "EXPIRED";

/**
 * The shift's calendar day as a UTC-midnight @db.Date, matching how the planning
 * board stores its cells (so the upsert lands on the same [worker, day] row the
 * admin grid reads).
 */
function boardDate(shiftDate: Date): Date {
  return dateOnlyUTC(ymdFromUTC(shiftDate));
}

/**
 * Accept an allocation, re-checking slot availability inside a transaction so two
 * workers accepting the last slot cannot both be confirmed. On success it also
 * reflects the result onto the planning board (the worker's cell for that day
 * becomes a SCHEDULED shift). Emits real-time events so dashboards update without
 * a refresh.
 */
export async function acceptAllocation(
  allocationId: string,
  shiftId: string
): Promise<AcceptOutcome> {
  let boardWorkerId: string | null = null;
  let boardDateKey: string | null = null;

  const outcome = await prisma.$transaction(async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!shift) return "MISSING" as const;

    const alloc = await tx.allocation.findUnique({ where: { id: allocationId } });
    if (!alloc) return "MISSING" as const;

    // RTW gatekeeper: a worker whose Right to Work has expired can't be booked,
    // even by accepting an offer. Leave the allocation untouched (no confirm, no
    // board change) so the caller can notify them.
    const worker = await tx.worker.findUnique({ where: { id: alloc.workerId } });
    if (!worker) return "MISSING" as const;
    if (isRtwExpired(worker.rtwExpiryDate)) return "EXPIRED" as const;

    const confirmedCount = await tx.allocation.count({
      where: { shiftId, state: "CONFIRMED" },
    });

    if (confirmedCount >= shift.slotsNeeded) {
      await tx.allocation.update({
        where: { id: allocationId },
        data: { state: "TIMEOUT" },
      });
      return "FULL" as const;
    }

    await tx.allocation.update({
      where: { id: allocationId },
      data: { state: "CONFIRMED" },
    });

    // Reflect onto the board: this day is now a scheduled shift.
    const date = boardDate(shift.date);
    await tx.rotaCell.upsert({
      where: { workerId_date: { workerId: alloc.workerId, date } },
      create: {
        workerId: alloc.workerId,
        date,
        status: "SCHEDULED",
        confirmed: true,
        startTime: shift.startTime,
        endTime: shift.endTime,
        clientId: shift.clientId,
      },
      update: {
        status: "SCHEDULED",
        confirmed: true,
        startTime: shift.startTime,
        endTime: shift.endTime,
        clientId: shift.clientId,
      },
    });
    boardWorkerId = alloc.workerId;
    boardDateKey = ymdFromUTC(date);
    return "CONFIRMED" as const;
  });

  if (outcome === "CONFIRMED" || outcome === "FULL") {
    emitRotaEvent({
      type: "allocation.updated",
      payload: {
        allocationId,
        shiftId,
        state: outcome === "CONFIRMED" ? "CONFIRMED" : "TIMEOUT",
      },
    });
  }
  if (outcome === "CONFIRMED" && boardWorkerId && boardDateKey) {
    emitRotaEvent({
      type: "board.updated",
      payload: { workerId: boardWorkerId, date: boardDateKey },
    });
  }

  return outcome;
}

/**
 * Decline an allocation, freeing the slot, and reflect it onto the board (the
 * worker's cell for that day becomes REJECTED). Emits real-time events.
 */
export async function declineAllocation(
  allocationId: string,
  shiftId: string
): Promise<void> {
  const reflected = await prisma.$transaction(async (tx) => {
    await tx.allocation.update({
      where: { id: allocationId },
      data: { state: "DECLINED" },
    });

    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    const alloc = await tx.allocation.findUnique({ where: { id: allocationId } });
    if (!shift || !alloc) return null;

    const date = boardDate(shift.date);
    await tx.rotaCell.upsert({
      where: { workerId_date: { workerId: alloc.workerId, date } },
      create: {
        workerId: alloc.workerId,
        date,
        status: "REJECTED",
        confirmed: false,
        startTime: null,
        endTime: null,
        clientId: shift.clientId,
      },
      update: {
        status: "REJECTED",
        confirmed: false,
        startTime: null,
        endTime: null,
        clientId: shift.clientId,
      },
    });
    return { workerId: alloc.workerId, dateKey: ymdFromUTC(date) };
  });

  emitRotaEvent({
    type: "allocation.updated",
    payload: { allocationId, shiftId, state: "DECLINED" },
  });
  if (reflected) {
    emitRotaEvent({
      type: "board.updated",
      payload: { workerId: reflected.workerId, date: reflected.dateKey },
    });
  }
}
