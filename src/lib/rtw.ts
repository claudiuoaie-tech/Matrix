// Right to Work (RTW) compliance helpers: expiry check + a daily alert sweep.

import { prisma } from "./prisma";
import { sendEmail, ADMIN_ALERT_EMAIL } from "./email";
import { fireWebhook } from "../services/webhook.service";

// Workers we've already posted an RTW-expiry webhook for, so the daily sweep only
// fires once per worker as they "cross into expired territory" (per process run).
const rtwWebhookFired = new Set<string>();

/** UTC-midnight Date for "today" (or a given reference). */
function utcMidnight(ref: Date = new Date()): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A worker's RTW is expired once the expiry date is strictly before today
 * (the worker is valid through the whole of their expiry day). Null = not
 * recorded, which is treated as not expired.
 */
export function isRtwExpired(date: Date | null | undefined, ref: Date = new Date()): boolean {
  if (!date) return false;
  return utcMidnight(new Date(date)) < utcMidnight(ref);
}

/**
 * Find every active/suspended worker whose RTW has expired and send a single
 * high-priority digest email to the admin. Returns how many were expired.
 */
export async function runRtwExpiryCheck(): Promise<number> {
  const today = utcMidnight();
  const expired = await prisma.worker.findMany({
    where: {
      status: { in: ["ACTIVE", "SUSPENDED"] },
      rtwExpiryDate: { lt: today },
    },
    select: { id: true, name: true, phone: true, email: true, rtwExpiryDate: true },
    orderBy: { rtwExpiryDate: "asc" },
  });

  // Fan out a webhook the first time each worker is seen as expired (per process).
  for (const w of expired) {
    if (rtwWebhookFired.has(w.id)) continue;
    rtwWebhookFired.add(w.id);
    void fireWebhook("worker.rtw_expired", {
      workerId: w.id,
      workerName: w.name,
      phone: w.phone,
      email: w.email,
      rtwExpiryDate: w.rtwExpiryDate ? ymd(new Date(w.rtwExpiryDate)) : null,
    });
  }

  if (expired.length === 0) return 0;

  const rows = expired
    .map(
      (w) =>
        `<li><strong>${w.name}</strong> (${w.phone}) — RTW expired ${
          w.rtwExpiryDate ? ymd(new Date(w.rtwExpiryDate)) : "unknown"
        }</li>`
    )
    .join("");

  await sendEmail(
    ADMIN_ALERT_EMAIL,
    `[HIGH] ${expired.length} worker${expired.length === 1 ? "" : "s"} with expired Right to Work`,
    `<p>The following worker${expired.length === 1 ? " has" : "s have"} an expired Right to Work and cannot be allocated shifts until it is renewed:</p><ul>${rows}</ul>`,
    { priority: "high" }
  );

  console.log(`[rtw] expiry sweep: ${expired.length} expired worker(s) — admin alerted.`);
  return expired.length;
}

/**
 * Run the sweep shortly after startup, then once every 24h. Idempotent enough for
 * a long-running dev server; a production deployment would use a real cron.
 */
export function startRtwScheduler(): void {
  setTimeout(() => {
    runRtwExpiryCheck().catch((err) => console.error("[rtw] sweep failed:", err));
  }, 5_000);
  setInterval(() => {
    runRtwExpiryCheck().catch((err) => console.error("[rtw] sweep failed:", err));
  }, 24 * 60 * 60 * 1000);
}
