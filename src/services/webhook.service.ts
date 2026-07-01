// Outbound webhook service. Fires fire-and-forget POST requests to
// OUTBOUND_WEBHOOK_URL when a critical system event occurs so external HR sheets
// / automation platforms can sync in real time. Mirrors the SMS/email helpers:
// when no URL is configured it logs the payload (mock mode), and a delivery
// failure is always swallowed so it can never crash a request or scheduler.

const OUTBOUND_WEBHOOK_URL = process.env.OUTBOUND_WEBHOOK_URL ?? "";

/** Critical events that fan out to the configured webhook destination. */
export type WebhookEvent =
  | "no_show.logged"
  | "worker.rtw_expired"
  | "holiday.requested"
  | "shift.cancelled";

const configured = OUTBOUND_WEBHOOK_URL.trim().length > 0;

/**
 * Send one event to the outbound webhook. Intentionally NOT awaited by callers
 * (fire-and-forget) — call as `void fireWebhook(...)`. A 5s timeout guards
 * against a slow/hung receiver holding resources.
 */
export async function fireWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  if (!configured) {
    console.log(`[webhook:mock] ${event} -> ${JSON.stringify(data)}`);
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(OUTBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(`[webhook] failed to deliver "${event}":`, err);
  }
}
