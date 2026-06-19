/**
 * Mock integration harness for POST /api/webhooks/twilio.
 *
 * Boots the real Express app on an ephemeral port, seeds a client + shift +
 * workers + PROPOSED allocations, then fires simulated Twilio inbound-SMS
 * payloads and asserts the resulting allocation state transitions in the
 * database.
 *
 * Requirements:
 *   - A reachable PostgreSQL (DATABASE_URL in .env) with the schema applied
 *     (`npm run prisma:migrate` or `npx prisma db push`).
 *   - VALIDATE_TWILIO_SIGNATURE=false (set in .env) so the harness can post
 *     without a genuine Twilio signature.
 *
 * Run with: npm run test:webhook
 */
import "dotenv/config";
import type { AddressInfo } from "net";
import { app } from "../src/index";
import { prisma } from "../src/lib/prisma";
import { dateOnlyUTC } from "../src/lib/board";

const TEST_PHONE_A = "+15550000001";
const TEST_PHONE_B = "+15550000002";
const TEST_PHONE_C = "+15550000003";
const TEST_PHONE_E = "+15550000005"; // replies "YES please"
const TEST_PHONE_F = "+15550000006"; // replies "no sorry"
const TEST_PHONE_G = "+15550000007"; // replies "I think 1 works" (contains 1)
const TEST_PHONE_H = "+15550000008"; // replies "1 or 2?" (contradictory)
const TEST_PHONE_I = "+15550000010"; // expired RTW, replies "1"
const SUSPENDED_PHONE = "+15550000009";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

/** POST a simulated Twilio webhook (urlencoded form body) and return the text. */
async function postTwilio(
  baseUrl: string,
  payload: Record<string, string>
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/api/webhooks/twilio`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload).toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function cleanup(): Promise<void> {
  const phones = [
    TEST_PHONE_A,
    TEST_PHONE_B,
    TEST_PHONE_C,
    TEST_PHONE_E,
    TEST_PHONE_F,
    TEST_PHONE_G,
    TEST_PHONE_H,
    TEST_PHONE_I,
    SUSPENDED_PHONE,
  ];
  // Allocations and rota cells cascade-delete with their worker, but remove
  // explicitly for clarity and to keep the harness idempotent.
  await prisma.rotaCell.deleteMany({
    where: { worker: { phone: { in: phones } } },
  });
  await prisma.allocation.deleteMany({
    where: { worker: { phone: { in: phones } } },
  });
  await prisma.worker.deleteMany({ where: { phone: { in: phones } } });
  await prisma.client.deleteMany({
    where: { companyName: "MOCK_TEST_CLIENT" },
  });
}

async function main(): Promise<void> {
  await cleanup();

  // --- Seed --------------------------------------------------------------
  const client = await prisma.client.create({
    data: {
      companyName: "MOCK_TEST_CLIENT",
      address: "1 Test Way",
      status: "ACTIVE",
    },
  });

  // Shift with a single slot so we can exercise the "shift full" path.
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      date: new Date("2026-07-01T00:00:00.000Z"),
      startTime: "09:00",
      endTime: "17:00",
      slotsNeeded: 1,
    },
  });

  // A roomier shift (5 slots) for the YES/NO / "contains" parsing scenarios.
  const shift2 = await prisma.shift.create({
    data: {
      clientId: client.id,
      date: new Date("2026-07-02T00:00:00.000Z"),
      startTime: "08:00",
      endTime: "16:00",
      slotsNeeded: 5,
    },
  });

  const workerA = await prisma.worker.create({
    data: { name: "Alice", phone: TEST_PHONE_A, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const workerB = await prisma.worker.create({
    data: { name: "Bob", phone: TEST_PHONE_B, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const workerC = await prisma.worker.create({
    data: { name: "Carol", phone: TEST_PHONE_C, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const suspended = await prisma.worker.create({
    data: {
      name: "Dave",
      phone: SUSPENDED_PHONE,
      status: "SUSPENDED",
      clientPool: "POOL_A",
    },
  });

  const allocA = await prisma.allocation.create({
    data: { shiftId: shift.id, workerId: workerA.id, state: "PROPOSED" },
  });
  const allocB = await prisma.allocation.create({
    data: { shiftId: shift.id, workerId: workerB.id, state: "PROPOSED" },
  });
  const allocC = await prisma.allocation.create({
    data: { shiftId: shift.id, workerId: workerC.id, state: "PROPOSED" },
  });
  await prisma.allocation.create({
    data: { shiftId: shift.id, workerId: suspended.id, state: "PROPOSED" },
  });

  // Workers + PROPOSED allocations on shift2 for the parsing scenarios.
  const workerE = await prisma.worker.create({
    data: { name: "Erin", phone: TEST_PHONE_E, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const workerF = await prisma.worker.create({
    data: { name: "Frank", phone: TEST_PHONE_F, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const workerG = await prisma.worker.create({
    data: { name: "Gita", phone: TEST_PHONE_G, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const workerH = await prisma.worker.create({
    data: { name: "Hugo", phone: TEST_PHONE_H, status: "ACTIVE", clientPool: "POOL_A" },
  });
  const allocE = await prisma.allocation.create({
    data: { shiftId: shift2.id, workerId: workerE.id, state: "PROPOSED" },
  });
  const allocF = await prisma.allocation.create({
    data: { shiftId: shift2.id, workerId: workerF.id, state: "PROPOSED" },
  });
  const allocG = await prisma.allocation.create({
    data: { shiftId: shift2.id, workerId: workerG.id, state: "PROPOSED" },
  });
  const allocH = await prisma.allocation.create({
    data: { shiftId: shift2.id, workerId: workerH.id, state: "PROPOSED" },
  });

  // Worker with an expired Right to Work, offered a shift on shift2.
  const workerI = await prisma.worker.create({
    data: {
      name: "Ivy",
      phone: TEST_PHONE_I,
      status: "ACTIVE",
      clientPool: "POOL_A",
      rtwExpiryDate: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const allocI = await prisma.allocation.create({
    data: { shiftId: shift2.id, workerId: workerI.id, state: "PROPOSED" },
  });

  // --- Boot the app on an ephemeral port ---------------------------------
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Mock server listening on ${baseUrl}\n`);

  try {
    // 1. Worker A accepts -> CONFIRMED (slot available).
    console.log("Scenario 1: Worker A replies '1' (accept) with a free slot");
    const r1 = await postTwilio(baseUrl, { From: TEST_PHONE_A, Body: "1" });
    assert(r1.status === 200, "responds 200");
    assert(/confirmed/i.test(r1.text), "reply confirms the booking");
    const afterA = await prisma.allocation.findUnique({ where: { id: allocA.id } });
    assert(afterA?.state === "CONFIRMED", "allocation A -> CONFIRMED");
    const cellA = await prisma.rotaCell.findUnique({
      where: { workerId_date: { workerId: workerA.id, date: dateOnlyUTC("2026-07-01") } },
    });
    assert(
      cellA?.status === "SCHEDULED" && cellA?.startTime === "09:00",
      "board cell A -> SCHEDULED 09:00"
    );

    // 2. Worker B accepts -> TIMEOUT (shift now full).
    console.log("\nScenario 2: Worker B replies '1' but the shift is full");
    const r2 = await postTwilio(baseUrl, { From: TEST_PHONE_B, Body: "1" });
    assert(r2.status === 200, "responds 200");
    assert(/filled|stay tuned/i.test(r2.text), "reply says slot was filled");
    const afterB = await prisma.allocation.findUnique({ where: { id: allocB.id } });
    assert(afterB?.state === "TIMEOUT", "allocation B -> TIMEOUT");

    // 3. Worker C declines -> DECLINED.
    console.log("\nScenario 3: Worker C replies '2' (decline)");
    const r3 = await postTwilio(baseUrl, { From: TEST_PHONE_C, Body: "2" });
    assert(r3.status === 200, "responds 200");
    assert(/not available|recorded/i.test(r3.text), "reply confirms the decline");
    const afterC = await prisma.allocation.findUnique({ where: { id: allocC.id } });
    assert(afterC?.state === "DECLINED", "allocation C -> DECLINED");
    const cellC = await prisma.rotaCell.findUnique({
      where: { workerId_date: { workerId: workerC.id, date: dateOnlyUTC("2026-07-01") } },
    });
    assert(cellC?.status === "REJECTED", "board cell C -> REJECTED");

    // 4. Suspended worker is ignored (no state change, empty reply).
    console.log("\nScenario 4: Suspended worker reply is ignored");
    const r4 = await postTwilio(baseUrl, { From: SUSPENDED_PHONE, Body: "1" });
    assert(r4.status === 200, "responds 200");
    assert(!/confirmed/i.test(r4.text), "no confirmation sent to suspended worker");

    // 5. Unknown sender is ignored safely.
    console.log("\nScenario 5: Unknown phone number is ignored");
    const r5 = await postTwilio(baseUrl, { From: "+19998887777", Body: "1" });
    assert(r5.status === 200, "responds 200 (safe no-op)");

    // 6. Unrecognised reply from a worker with no proposal left.
    console.log("\nScenario 6: Worker A sends gibberish (no PROPOSED allocation left)");
    const r6 = await postTwilio(baseUrl, { From: TEST_PHONE_A, Body: "maybe?" });
    assert(r6.status === 200, "responds 200");

    const day2 = dateOnlyUTC("2026-07-02");

    // 7. "YES please" behaves like "1" -> CONFIRMED + SCHEDULED board cell.
    console.log('\nScenario 7: Worker E replies "YES please" (accept)');
    const r7 = await postTwilio(baseUrl, { From: TEST_PHONE_E, Body: "YES please" });
    assert(r7.status === 200, "responds 200");
    assert(/confirmed/i.test(r7.text), "reply confirms the booking");
    const afterE = await prisma.allocation.findUnique({ where: { id: allocE.id } });
    assert(afterE?.state === "CONFIRMED", "allocation E -> CONFIRMED");
    const cellE = await prisma.rotaCell.findUnique({
      where: { workerId_date: { workerId: workerE.id, date: day2 } },
    });
    assert(cellE?.status === "SCHEDULED", "board cell E -> SCHEDULED");

    // 8. "no sorry" behaves like "2" -> DECLINED + REJECTED board cell.
    console.log('\nScenario 8: Worker F replies "no sorry" (decline)');
    const r8 = await postTwilio(baseUrl, { From: TEST_PHONE_F, Body: "no sorry" });
    assert(r8.status === 200, "responds 200");
    assert(/not available|recorded/i.test(r8.text), "reply confirms the decline");
    const afterF = await prisma.allocation.findUnique({ where: { id: allocF.id } });
    assert(afterF?.state === "DECLINED", "allocation F -> DECLINED");
    const cellF = await prisma.rotaCell.findUnique({
      where: { workerId_date: { workerId: workerF.id, date: day2 } },
    });
    assert(cellF?.status === "REJECTED", "board cell F -> REJECTED");

    // 9. A sentence containing "1" still counts as an accept.
    console.log('\nScenario 9: Worker G replies "I think 1 works" (contains 1)');
    const r9 = await postTwilio(baseUrl, { From: TEST_PHONE_G, Body: "I think 1 works" });
    assert(r9.status === 200, "responds 200");
    assert(/confirmed/i.test(r9.text), "reply confirms the booking");
    const afterG = await prisma.allocation.findUnique({ where: { id: allocG.id } });
    assert(afterG?.state === "CONFIRMED", "allocation G -> CONFIRMED");

    // 10. Contradictory reply ("1 or 2?") is treated as not understood.
    console.log('\nScenario 10: Worker H replies "1 or 2?" (contradictory -> clarify)');
    const r10 = await postTwilio(baseUrl, { From: TEST_PHONE_H, Body: "1 or 2?" });
    assert(r10.status === 200, "responds 200");
    assert(/didn't understand/i.test(r10.text), "reply asks for a clear answer");
    const afterH = await prisma.allocation.findUnique({ where: { id: allocH.id } });
    assert(afterH?.state === "PROPOSED", "allocation H stays PROPOSED");

    // 11. Expired-RTW worker replies "1" -> blocked, no booking, no board cell.
    console.log('\nScenario 11: Worker I (expired RTW) replies "1" (blocked)');
    const r11 = await postTwilio(baseUrl, { From: TEST_PHONE_I, Body: "1" });
    assert(r11.status === 200, "responds 200");
    assert(
      /onboarding documentation has expired/i.test(r11.text),
      "reply tells them their documentation has expired"
    );
    const afterI = await prisma.allocation.findUnique({ where: { id: allocI.id } });
    assert(afterI?.state === "PROPOSED", "allocation I stays PROPOSED (not booked)");
    const cellI = await prisma.rotaCell.findUnique({
      where: { workerId_date: { workerId: workerI.id, date: day2 } },
    });
    assert(!cellI, "no board cell created for expired worker");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exitCode = 1;
});
