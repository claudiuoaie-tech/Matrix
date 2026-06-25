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
): Promise<void> {
  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log(
      `[sms:mock] -> ${to}: ${body}${mediaUrls?.length ? ` [media: ${mediaUrls.join(", ")}]` : ""}`
    );
    return;
  }

  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_FROM_NUMBER,
      body,
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
  } catch (err) {
    console.error(`[sms] failed to send to ${to}:`, err);
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
): Promise<void> {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log(
      `[whatsapp:mock] -> ${to}: ${body}${mediaUrls?.length ? ` [media: ${mediaUrls.join(", ")}]` : ""}`
    );
    return;
  }

  try {
    await twilioClient.messages.create({
      to: toWhatsApp(to),
      from: toWhatsApp(TWILIO_WHATSAPP_FROM),
      body,
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
  } catch (err) {
    console.error(`[whatsapp] failed to send to ${to}:`, err);
  }
}

/** Dispatch a message on the chosen channel (SMS by default), with optional media. */
export async function sendMessage(
  to: string,
  body: string,
  channel: SendChannel = "SMS",
  mediaUrls?: string[]
): Promise<void> {
  return channel === "WHATSAPP"
    ? sendWhatsApp(to, body, mediaUrls)
    : sendSms(to, body, mediaUrls);
}
