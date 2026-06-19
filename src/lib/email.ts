// Email service. Uses Resend (https://resend.com) when RESEND_API_KEY is set;
// otherwise it logs the message (mock mode) so flows run end-to-end locally
// without real credentials — mirroring the Twilio SMS helper.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "Rota-Matrix <alerts@rota-matrix.local>";

/** Where compliance/admin alerts are sent. */
export const ADMIN_ALERT_EMAIL =
  process.env.ADMIN_ALERT_EMAIL ?? "admin@rota-matrix.local";

const configured =
  !!RESEND_API_KEY &&
  !RESEND_API_KEY.includes("xxxx") &&
  RESEND_API_KEY !== "your_resend_api_key_here";

/**
 * Send an email. High-priority flag sets the standard priority headers. Failures
 * are logged, never thrown, so an alert can't crash the scheduler or a request.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  opts: { priority?: "high" } = {}
): Promise<void> {
  if (!configured) {
    console.log(
      `[email:mock]${opts.priority === "high" ? " [HIGH]" : ""} -> ${to} | ${subject}\n${html}`
    );
    return;
  }

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to,
        subject,
        html,
        headers:
          opts.priority === "high"
            ? { "X-Priority": "1", Importance: "high" }
            : undefined,
      }),
    });
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err);
  }
}
