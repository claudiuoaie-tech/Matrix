/**
 * Unified outbound message dispatch. Splits channel routing cleanly so the rest
 * of the app calls ONE function regardless of provider:
 *
 *   - SMS      → Twilio (lib/twilio.ts), unchanged E.164 logic.
 *   - WHATSAPP → Whapi.cloud (lib/whapi.ts), bypassing Twilio/Meta entirely.
 *
 * Both providers return the same SendResult, so callers (reply, send-direct,
 * broadcast) handle success/failure identically.
 */
import type { MessageChannel } from "@prisma/client";
import { sendSms, type SendResult } from "./twilio";
import { sendWhatsAppViaWhapi } from "./whapi";

export async function dispatchMessage(
  to: string,
  body: string,
  channel: MessageChannel,
  mediaUrls?: string[]
): Promise<SendResult> {
  if (channel === "WHATSAPP") {
    // Whapi sends a single attachment per message; take the first if present.
    return sendWhatsAppViaWhapi(to, body, mediaUrls?.[0] ?? null);
  }
  return sendSms(to, body, mediaUrls);
}
