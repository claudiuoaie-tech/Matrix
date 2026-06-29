/**
 * Whapi.cloud WhatsApp gateway.
 *
 * As of the WhatsApp migration, ALL WhatsApp traffic (outbound + inbound) runs
 * through Whapi.cloud instead of Twilio — Whapi connects a real WhatsApp number
 * directly, so there's no Meta 24-hour customer-care window and we can message
 * cold recruits. Twilio still handles SMS unchanged (see lib/twilio.ts).
 *
 * Outbound: a thin REST wrapper over https://gate.whapi.cloud with the channel
 * token as a Bearer credential. Inbound is ingested by the public webhook at
 * /api/public/webhooks/whapi (see routes/public.ts).
 */
import type { SendResult } from "./twilio";

const WHAPI_API_TOKEN = process.env.WHAPI_API_TOKEN ?? "";

/**
 * The connected WhatsApp sender (MSISDN of the Whapi channel). Whapi infers the
 * sender from the token, so this is informational — used in logs and exposed for
 * health/config checks — not required in the request body.
 */
export const WHAPI_SENDER_ID = process.env.WHAPI_SENDER_ID ?? "";

/** Gateway base URL (override for a dedicated/regional gate if ever needed). */
const WHAPI_BASE = (process.env.WHAPI_BASE_URL ?? "https://gate.whapi.cloud").replace(/\/$/, "");

/** Whether a real Whapi token is configured; otherwise WhatsApp runs in mock mode. */
export const whapiConfigured = !!WHAPI_API_TOKEN;

/** Authorization header for any Whapi REST call. */
function whapiAuthHeader(): string {
  return `Bearer ${WHAPI_API_TOKEN}`;
}

/** True if a URL points at Whapi-hosted media (needs the bearer token to fetch). */
export function isWhapiMediaUrl(url: string): boolean {
  return /(?:^|\.)whapi\.cloud\//i.test(url);
}

/** Bearer header for fetching Whapi-hosted inbound media in the admin proxy. */
export function whapiMediaAuthHeader(): string | null {
  return whapiConfigured ? whapiAuthHeader() : null;
}

/**
 * Whapi addresses recipients by bare MSISDN (digits only, no "+", no
 * "whatsapp:" prefix) — e.g. "447459327787". Coerce whatever we hold (E.164,
 * national, channel-prefixed) into that shape.
 */
function toWhapiRecipient(raw: string): string {
  return String(raw)
    .trim()
    .replace(/^whatsapp:/i, "")
    .replace(/\D/g, "");
}

/** PDFs go to /messages/document; everything else (images) to /messages/image. */
function isDocument(url: string): boolean {
  return /\.pdf(?:$|\?)/i.test(url);
}

interface WhapiResponse {
  sent?: boolean;
  message?: { id?: string };
  error?: { code?: string | number; message?: string };
}

/**
 * Send a WhatsApp message via Whapi. Mirrors the Twilio senders' contract: never
 * throws, returns a SendResult so the caller decides whether to surface failure.
 * Media is passed as a URL (our public /api/public/media link), which Whapi
 * fetches server-side; `body` becomes the caption.
 */
export async function sendWhatsAppViaWhapi(
  to: string,
  body: string,
  mediaUrl?: string | null
): Promise<SendResult> {
  if (!whapiConfigured) {
    console.log(
      `[whapi:mock] -> ${to}: ${body}${mediaUrl ? ` [media: ${mediaUrl}]` : ""}`
    );
    return { ok: true, mock: true };
  }

  const recipient = toWhapiRecipient(to);
  if (!recipient) {
    return { ok: false, message: "Empty/invalid WhatsApp recipient number." };
  }

  // Choose endpoint + payload by attachment type. Text-only is the common path.
  const endpoint = mediaUrl
    ? isDocument(mediaUrl)
      ? "/messages/document"
      : "/messages/image"
    : "/messages/text";
  const payload: Record<string, unknown> = mediaUrl
    ? { to: recipient, media: mediaUrl, caption: body || undefined }
    : { to: recipient, body };

  try {
    const res = await fetch(`${WHAPI_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: whapiAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => null)) as WhapiResponse | null;

    // Whapi signals failure via a non-2xx status and/or { sent:false, error }.
    if (!res.ok || data?.sent === false || data?.error) {
      const code = data?.error?.code ?? res.status;
      const message = data?.error?.message ?? `Whapi responded ${res.status}`;
      console.error("Whapi WhatsApp Send Error:", message, code, `(to=${recipient})`);
      return { ok: false, code, message };
    }

    console.log(`[whapi] sent id=${data?.message?.id ?? "?"} -> ${recipient}`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Whapi WhatsApp Send Error (network):", message, `(to=${recipient})`);
    return { ok: false, message };
  }
}

/** One inbound message parsed from a Whapi webhook payload. */
export interface WhapiInbound {
  fromNumber: string; // E.164 ("+44…")
  body: string;
  mediaUrl: string | null;
}

/** Prefix a bare Whapi MSISDN ("447…") with "+" so it matches stored E.164 phones. */
function toE164FromWhapi(raw: string): string {
  const digits = String(raw).replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * Extract inbound (not from_me) messages from a Whapi webhook body. Whapi posts
 * `{ messages: [ { from, from_me, type, text:{body}, image:{link,caption}, … } ] }`.
 * Echoes of our own outbound (from_me=true) and non-message events are skipped.
 */
export function parseWhapiInbound(payload: unknown): WhapiInbound[] {
  const messages = (payload as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return [];

  const out: WhapiInbound[] = [];
  for (const raw of messages) {
    const m = raw as Record<string, any>;
    if (!m || m.from_me) continue; // skip our own outbound echoes

    const fromNumber = toE164FromWhapi(m.from ?? m.chat_id ?? "");
    if (!fromNumber) continue;

    // Body + media vary by message type. Captions live on the media object.
    const media = m.image ?? m.document ?? m.video ?? m.audio ?? m.voice ?? null;
    const body = String(m.text?.body ?? media?.caption ?? "").trim();
    const mediaUrl = (media?.link ?? media?.url ?? null) || null;

    out.push({ fromNumber, body, mediaUrl });
  }
  return out;
}
