import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

export const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? "";

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
export async function sendSms(to: string, body: string): Promise<void> {
  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log(`[sms:mock] -> ${to}: ${body}`);
    return;
  }

  try {
    await twilioClient.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
  } catch (err) {
    console.error(`[sms] failed to send to ${to}:`, err);
  }
}
