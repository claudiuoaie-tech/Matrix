import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

export const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? "";

// WhatsApp sender. Falls back to the SMS number if a WhatsApp-specific sender
// isn't configured (some setups enable WhatsApp on the same number, or use the
// Twilio sandbox number during testing).
export const TWILIO_WHATSAPP_FROM =
  process.env.TWILIO_WHATSAPP_FROM ?? TWILIO_FROM_NUMBER;

/** Public base URL, for building the delivery status-callback webhook. */
function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
}

/**
 * Delivery status callback. messages.create only tells us the message was
 * ACCEPTED/QUEUED — the real outcome (delivered / undelivered + errorCode like
 * 63016) arrives asynchronously at this webhook, which logs it.
 */
function statusCallbackUrl(): string | undefined {
  const base = publicBaseUrl();
  return base ? `${base}/api/webhooks/twilio/status` : undefined;
}

/** Outbound channels a message can be dispatched on. */
export type SendChannel = "SMS" | "WHATSAPP";

/**
 * Default dialling code for bare national numbers (no "+" / no country code).
 * Matrix operates in the UK, so a number entered as "07459327787" is assumed to
 * be a UK mobile and rendered "+447459327787". Override via DEFAULT_DIAL_CODE.
 */
const DEFAULT_DIAL_CODE = (process.env.DEFAULT_DIAL_CODE ?? "44").replace(/\D/g, "");

/**
 * Normalise a human-entered phone number to E.164 ("+447459327787"), the only
 * format Twilio accepts. Twilio rejects national formats like "07459327787"
 * with error 21211, so we coerce here rather than at every call site.
 *
 *  - strips a leading "whatsapp:" channel prefix and any spaces/dashes/parens
 *  - "+4474..."  → unchanged (already E.164)
 *  - "004474..." → "+4474..."  (international access code)
 *  - "07459..."  → "+44 7459..." (leading 0 = national trunk → default code)
 *  - "4474..."   → "+4474..."   (bare country code, no plus)
 *
 * Anything else is returned with a leading "+" and left for Twilio to validate
 * (and now log explicitly) rather than guessing wrongly.
 */
export function toE164(raw: string): string {
  let n = String(raw)
    .trim()
    .replace(/^whatsapp:/i, "")
    .replace(/[\s()\-.]/g, "");
  if (!n) return n;
  if (n.startsWith("+")) return n;
  if (n.startsWith("00")) return "+" + n.slice(2);
  if (n.startsWith("0")) return "+" + DEFAULT_DIAL_CODE + n.slice(1);
  return "+" + n;
}

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
  // Twilio message SID on a successful real send — stored on the outbound row so
  // async delivery-status callbacks can be matched back to it.
  sid?: string;
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

  const statusCallback = statusCallbackUrl();
  try {
    // SMS path: E.164 number, no channel prefixing — kept entirely separate
    // from the WhatsApp formatting below so the two can't bleed.
    const message = await twilioClient.messages.create({
      to: toE164(to),
      from: TWILIO_FROM_NUMBER,
      body,
      ...(statusCallback ? { statusCallback } : {}),
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
    console.log(`[sms] accepted sid=${message.sid} status=${message.status} -> ${toE164(to)}`);
    return { ok: true, sid: message.sid };
  } catch (err) {
    const { code, message } = describeTwilioError(err);
    console.error("Twilio SMS Send Error:", message, code);
    return { ok: false, code, message };
  }
}

/** Normalise an address to a WhatsApp endpoint ("whatsapp:+44…", E.164 body). */
function toWhatsApp(addr: string): string {
  return `whatsapp:${toE164(addr)}`;
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
  const statusCallback = statusCallbackUrl();

  // Free-form WhatsApp — only delivers inside the 24h customer-care window.
  // Out-of-session (cold) sends must use sendWhatsAppTemplate() instead.
  try {
    const message = await twilioClient.messages.create({
      to: dest,
      from,
      body,
      ...(statusCallback ? { statusCallback } : {}),
      ...(mediaUrls?.length ? { mediaUrl: mediaUrls } : {}),
    });
    console.log(`[whatsapp] accepted sid=${message.sid} status=${message.status} -> ${dest}`);
    return { ok: true, sid: message.sid };
  } catch (err) {
    // Surface the exact Twilio code (e.g. 63015 number not on WhatsApp, 63016
    // free-form outside 24h window, 21910 from/to channel mismatch) in the logs.
    const { code, message } = describeTwilioError(err);
    console.error("Twilio WhatsApp Send Error:", message, code, `(from=${from} to=${dest})`);
    return { ok: false, code, message };
  }
}

/**
 * Sanitise a template variable value for Twilio's Content API.
 *
 * Twilio bug/validation 21656 rejects contentVariables containing a standard
 * vertical apostrophe ('), so we swap it for the typographic right single
 * quotation mark (’), which renders identically and passes validation.
 */
export function sanitizeTemplateValue(value: string): string {
  return String(value).replace(/'/g, "’");
}

/**
 * Send an out-of-session WhatsApp message using an approved Meta template via
 * Twilio's Content API. `variables` maps positional indices ("1".."N") to the
 * operator-supplied values, which are apostrophe-sanitised before sending.
 *
 * This is the ONLY way to reach a contact outside the 24h window (cold recruit,
 * dormant worker). Mirrors sendWhatsApp's contract: never throws, returns a
 * SendResult with the Twilio code on failure.
 */
export async function sendWhatsAppTemplate(
  to: string,
  contentSid: string,
  variables: Record<string, string>
): Promise<SendResult> {
  const sanitized: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) sanitized[k] = sanitizeTemplateValue(v);

  if (!twilioClient || !TWILIO_WHATSAPP_FROM) {
    console.log(
      `[whatsapp:template:mock] -> ${to}: ${contentSid} ${JSON.stringify(sanitized)}`
    );
    return { ok: true, mock: true };
  }

  const from = toWhatsApp(TWILIO_WHATSAPP_FROM);
  const dest = toWhatsApp(to);
  const statusCallback = statusCallbackUrl();

  try {
    const message = await twilioClient.messages.create({
      to: dest,
      from,
      contentSid,
      contentVariables: JSON.stringify(sanitized),
      ...(statusCallback ? { statusCallback } : {}),
    });
    console.log(
      `[whatsapp:template] accepted sid=${message.sid} status=${message.status} ` +
        `content=${contentSid} -> ${dest}`
    );
    return { ok: true, sid: message.sid };
  } catch (err) {
    const { code, message } = describeTwilioError(err);
    console.error("Twilio WhatsApp Template Send Error:", message, code, `(content=${contentSid} to=${dest})`);
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
