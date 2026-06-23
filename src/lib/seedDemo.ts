// Idempotent demo-data seed, safe to run against production.
//
// Unlike prisma/seed.ts (the destructive local reset), this NEVER deletes
// anything: it only inserts a demo dataset when the database is empty (no
// clients yet). Re-running it on a populated DB is a no-op, so it can't clobber
// real data. Shared by the admin `POST /seed` endpoint and `npm run seed:prod`.

import { prisma } from "./prisma";
import { ClientPool, ShiftSlot, RotaStatus } from "@prisma/client";
import { mondayKey, windowKeys, dateOnlyUTC } from "./board";

export interface SeedResult {
  seeded: boolean;
  clients: number;
  workers: number;
  shifts: number;
  message: string;
}

function weekStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const SLOT_TIMES: Record<ShiftSlot, { start: string; end: string }> = {
  AM: { start: "06:00", end: "14:00" },
  PM: { start: "14:00", end: "22:00" },
  NIGHT: { start: "22:00", end: "06:00" },
};

export async function seedDemoData(): Promise<SeedResult> {
  // Guard: only seed an empty database — never touch existing data.
  const existingClients = await prisma.client.count();
  if (existingClients > 0) {
    return {
      seeded: false,
      clients: 0,
      workers: 0,
      shifts: 0,
      message: "Database already has data — seed skipped (no changes made).",
    };
  }

  const monday = weekStart();

  // --- Clients (each bound to a pool) -----------------------------------
  const clientDefs = [
    { companyName: "Client A — Northgate Logistics", address: "12 Dock Road", pool: ClientPool.POOL_A },
    { companyName: "Client B — Riverside Foods", address: "8 Mill Lane", pool: ClientPool.POOL_B },
    { companyName: "Client C — Summit Events", address: "44 High Street", pool: ClientPool.POOL_C },
  ];
  const clients = [];
  for (const c of clientDefs) {
    clients.push(await prisma.client.create({ data: c }));
  }
  const clientByPool = new Map(clients.map((c) => [c.pool, c]));

  // --- Shift templates per client ---------------------------------------
  const templateDefs = [
    { name: "Early", startTime: "06:00", endTime: "14:00" },
    { name: "Day", startTime: "09:00", endTime: "17:00" },
    { name: "Late", startTime: "14:00", endTime: "22:00" },
    { name: "Night", startTime: "22:00", endTime: "06:00" },
  ];
  for (const client of clients) {
    for (const t of templateDefs) {
      await prisma.shiftTemplate.create({ data: { clientId: client.id, ...t } });
    }
  }

  // --- Workers (full "First Last" names, spread across pools) ------------
  const roster = [
    "Ajay Bolligorla", "Akshay Vijayakumar", "Akshay Girish Kumar", "Alby Biju Philip",
    "Ali Ashar", "Althaf Muhammad", "Anagha Sanal Kumar", "Angel Seby",
    "Anna Navomi", "Arunkumar Burra", "Asna Nalakath", "Bharadwaj Kanakam",
    "Bineesh Thottappully", "Bivil Shibu", "Chris Josy",
  ];
  const pools = [ClientPool.POOL_A, ClientPool.POOL_B, ClientPool.POOL_C];
  const workers = [];
  let phoneSeq = 1000;
  for (let i = 0; i < roster.length; i++) {
    const pool = pools[Math.floor(i / 5)]; // 5 per pool
    workers.push(
      await prisma.worker.create({
        data: { name: roster[i], phone: `+1555000${phoneSeq++}`, clientPool: pool },
      })
    );
  }

  // --- Shifts (used by the broadcast engine) ----------------------------
  const slots: ShiftSlot[] = [ShiftSlot.AM, ShiftSlot.PM];
  const days = [0, 2, 4];
  let shiftCount = 0;
  for (const client of clients) {
    for (const dayOffset of days) {
      for (const slot of slots) {
        await prisma.shift.create({
          data: {
            clientId: client.id,
            date: addDays(monday, dayOffset),
            slot,
            startTime: SLOT_TIMES[slot].start,
            endTime: SLOT_TIMES[slot].end,
            slotsNeeded: 2 + (dayOffset % 2),
          },
        });
        shiftCount++;
      }
    }
  }

  // --- Planning board cells (demonstrate every status colour) -----------
  const clientA = clientByPool.get(ClientPool.POOL_A)!;
  const poolAWorkers = workers.filter((w) => w.clientPool === ClientPool.POOL_A);
  const windowDates = windowKeys(mondayKey(), 14);

  type CellDef = { day: number; status: RotaStatus; startTime?: string };
  const demo: CellDef[][] = [
    [{ day: 0, status: "AVAILABLE" }],
    [{ day: 0, status: "SCHEDULED", startTime: "18:00" }, { day: 1, status: "UNAVAILABLE" }],
    [{ day: 0, status: "SCHEDULED", startTime: "20:00" }, { day: 2, status: "SICK" }],
    [{ day: 0, status: "SCHEDULED", startTime: "17:00" }, { day: 3, status: "REST" }],
    [{ day: 0, status: "CANCELLED" }, { day: 4, status: "HOLIDAY" }],
  ];
  for (let i = 0; i < poolAWorkers.length && i < demo.length; i++) {
    for (const cell of demo[i]) {
      await prisma.rotaCell.create({
        data: {
          workerId: poolAWorkers[i].id,
          clientId:
            cell.status === "SCHEDULED" || cell.status === "CANCELLED" ? clientA.id : null,
          date: dateOnlyUTC(windowDates[cell.day]),
          status: cell.status,
          startTime: cell.startTime ?? null,
        },
      });
    }
  }

  // A holiday request for variety in the worker portal.
  await prisma.holidayRequest.create({
    data: {
      workerId: workers[1].id,
      startDate: addDays(monday, 5),
      endDate: addDays(monday, 9),
      note: "Family trip",
    },
  });

  return {
    seeded: true,
    clients: clients.length,
    workers: workers.length,
    shifts: shiftCount,
    message: `Seeded ${clients.length} clients, ${workers.length} workers, ${shiftCount} shifts, plus templates and demo board cells.`,
  };
}
