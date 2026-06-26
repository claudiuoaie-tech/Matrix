import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

export const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? "";

// WhatsApp sender. Falls back to the SMS number if a WhatsApp-specific sender
// isn't configured (some setups enable WhatsApp on the same number, or use the
// Twilio sandbox number during testing).
export const TWILIO_WHATSAPP_FROM =
  process.env.TWILIO_WHATSAPP_FROM ?? TWILIO_FROM_NUMBER;

/** Outbound channels a message can be dispatched on. */
export type SendChannel = "SMS" | "WHATSAPP";

/**
 * Outcome of a dispatch attempt. Senders never throw — they report success or
 * failure here so the caller can decide whether to surface it (e.g. a single
 * ad-hoc reply should fail loudly, while a bulk broadcast keeps going).
 *
 *  - ok=true,  mock=true  → no real creds; logged only (treated as success).
 *  - ok=true             → Twilio accepted the message.
 *  - ok=false            → Twilio rejected it; `code`/`message` carry the reason.
 */
export interface SendResult {
  ok: boolean;
  mock?: boolean;
  code?: string | number;
  message?: string;
}

/** Pull Twilio's numeric error code + message off a thrown error, defensively. */
function describeTwilioError(err: unknown): { code?: string | number; message: string } {
  const e = err as { code?: string | number; status?: number; message?: string } | null;
  return {
    code: e?.code ?? e?.status,
    message: e?.message ?? String(err),
  };
}

/**
 * Whether real Twilio credentials are configured. The .env.example ships with
 * obvious placeholders ("ACxxxx...", "your_auth_token_here"); we treat those as
 * "not configured" so local dev and the test harness run in mock mode rather
 * than crashing on an authentication error.
 */
const credentialsConfigured =
  !!accountSid &&
  !!authToken &&
  accountSid.startsWith("AC") &&
  !accountSid.includes("xxxx") &&
  authToken !== "your_auth_token_here";

/**
 * The Twilio REST client, or null when running in mock mode.
 */
export const twilioClient = credentialsConfigured
  ? twilio(accountSid, authToken)
  : null;

/**
 * Send an SMS to a worker. In environments without real Twilio credentials this
 * logs the outbound message instead of sending so the flow can be exercised end
 * to end. A real send failure is logged but never thrown, so a single bad number
 * can't crash a request or abort a bulk broadcast.
 */
export async function sendSms(
  to: string,
  body: string,
  mediaUrls?: string[]
): Promise<SendResult> {
  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log(
      `[sms:mock] -> ${to}: ${body}${mediaUrls?.length ? ` [media: ${mediaUrls.join(", ")}]` : ""}`
    );
    return { ok: true, mock: true };
  }

  try {
    // SMS path: plain E.164 numbers, no channel prefixing — kept entirely
    // separate from the WhatsApp formatting below so the two can't bleed.
    await twilioClient.messages.create({
      to,
      from: TWILIO_FROM_NUMBER,
      body,
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
    return { ok: true };
  } catch (err) {
    const { code, message } = describeTwilioError(err);
    console.error("Twilio SMS Send Error:", message, code);
    return { ok: false, code, message };
  }
}

/** Normalise an address to a WhatsApp endpoint ("whatsapp:+44…"). */
function toWhatsApp(addr: string): string {
  return `whatsapp:${addr.trim().replace(/^whatsapp:/i, "")}`;
}

/**
 * Send a WhatsApp message via Twilio. Mirrors sendSms: mock-logs when creds /
 * sender aren't configured, and swallows send failures so one bad recipient
 * can't abort a bulk broadcast.
 */
export async function sendWhatsApp(
  to: string,
  body: string,
  mediaUrls?: string[]
): Promise<SendResult> {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log(
      `[whatsapp:mock] -> ${to}: ${body}${mediaUrls?.length ? ` [media: ${mediaUrls.join(", ")}]` : ""}`
    );
    return { ok: true, mock: true };
  }

  // Both endpoints MUST carry the "whatsapp:" prefix; toWhatsApp() adds it
  // idempotently so an already-prefixed sender/recipient isn't doubled up.
  const from = toWhatsApp(TWILIO_WHATSAPP_FROM);
  const dest = toWhatsApp(to);

  try {
    await twilioClient.messages.create({
      to: dest,
      from,
      body,
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
    return { ok: true };
  } catch (err) {
    // Surface the exact Twilio code (e.g. 63015 number not on WhatsApp, 63016
    // free-form outside 24h window, 21910 from/to channel mismatch) in the logs.
    const { code, message } = describeTwilioError(err);
    console.error("Twilio WhatsApp Send Error:", message, code, `(from=${from} to=${dest})`);
    return { ok: false, code, message };
  }
}

/** Dispatch a message on the chosen channel (SMS by default), with optional media. */
export async function sendMessage(
  to: string,
  body: string,
  channel: SendChannel = "SMS",
  mediaUrls?: string[]
): Promise<SendResult> {
  return channel === "WHATSAPP"
    ? sendWhatsApp(to, body, mediaUrls)
    : sendSms(to, body, mediaUrls);
}
