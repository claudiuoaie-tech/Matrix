/**
 * Seed demo data for Matrix.
 *
 *   npm run seed
 *
 * Creates three clients (A/B/C) each tied to a worker pool, a roster of workers,
 * shift templates per client, this/next week's shifts, and a set of planning
 * board cells (RotaCell) demonstrating every status colour.
 */
import "dotenv/config";
import { PrismaClient, ClientPool, ShiftSlot, RotaStatus } from "@prisma/client";
// Reuse the board's UTC date helpers so seeded cells land on the exact dates the
// board queries (avoids a timezone-offset day shift).
import { mondayKey, windowKeys, dateOnlyUTC } from "../src/lib/board";

const prisma = new PrismaClient();

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

async function main(): Promise<void> {
  console.log("Resetting demo data...");
  await prisma.rotaCell.deleteMany();
  await prisma.shiftTemplate.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.holidayRequest.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.worker.deleteMany();
  await prisma.client.deleteMany();

  const monday = weekStart();

  // --- Clients (each bound to a pool) -----------------------------------
  const clientDefs = [
    { companyName: "Client A — Northgate Logistics", address: "12 Dock Road", pool: ClientPool.POOL_A },
    { companyName: "Client B — Riverside Foods", address: "8 Mill Lane", pool: ClientPool.POOL_B },
    { companyName: "Client C — Summit Events", address: "44 High Street", pool: ClientPool.POOL_C },
  ];

  const clients = [];
  for (const c of clientDefs) {
    clients.push(
      await prisma.client.create({
        data: { companyName: c.companyName, address: c.address, pool: c.pool },
      })
    );
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

  // --- Shifts (still used by the broadcast engine) ----------------------
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

  // --- Planning board cells (mirrors the spec screenshot) ---------------
  const clientA = clientByPool.get(ClientPool.POOL_A)!;
  const poolAWorkers = workers.filter((w) => w.clientPool === ClientPool.POOL_A);
  // UTC date keys for the current 14-day board window.
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
          clientId: cell.status === "SCHEDULED" || cell.status === "CANCELLED" ? clientA.id : null,
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

  console.log(
    `Seeded: ${clients.length} clients, ${workers.length} workers, ${shiftCount} shifts, board cells + templates.`
  );
  console.log(`Demo login phone (active worker): ${workers[0].phone}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
