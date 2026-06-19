import { Request, Response, NextFunction } from "express";
import twilio from "twilio";

/**
 * Express middleware that verifies an incoming request genuinely originates from
 * Twilio by validating the `X-Twilio-Signature` header against the request URL
 * and POST body using the account auth token.
 *
 * Validation can be disabled for local testing by setting
 * `VALIDATE_TWILIO_SIGNATURE=false` — useful for the mock integration harness
 * which cannot produce a real Twilio signature.
 *
 * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const shouldValidate =
    (process.env.VALIDATE_TWILIO_SIGNATURE ?? "true").toLowerCase() !== "false";

  if (!shouldValidate) {
    next();
    return;
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error(
      "[twilio] TWILIO_AUTH_TOKEN is not set; cannot validate signature."
    );
    res.status(500).send("Server misconfigured");
    return;
  }

  const signature = req.header("X-Twilio-Signature") ?? "";

  // Reconstruct the exact public URL Twilio used to reach us. Behind a proxy the
  // host/proto headers matter, so prefer an explicitly configured base URL.
  const base =
    process.env.PUBLIC_BASE_URL ??
    `${req.protocol}://${req.get("host") ?? ""}`;
  const url = `${base}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    authToken,
    signature,
    url,
    req.body ?? {}
  );

  if (!isValid) {
    console.warn(`[twilio] Rejected request with invalid signature for ${url}`);
    res.status(403).send("Invalid Twilio signature");
    return;
  }

  next();
}
