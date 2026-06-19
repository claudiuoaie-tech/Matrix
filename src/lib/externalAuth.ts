import { timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Shared-secret authentication for the external integration gateway
 * (/api/v1/external/*). External automation platforms (Zapier, Make, n8n) and
 * the future AI email-parsing agent authenticate with a single key sent in the
 * `X-API-Key` header. Kept separate from the admin key so it can be rotated /
 * revoked independently of the operations console.
 */

const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY ?? "";

/** Constant-time comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Whether an external key has been configured at all. */
export function externalAuthConfigured(): boolean {
  return EXTERNAL_API_KEY.length > 0;
}

/** True if the supplied key matches the configured external key. */
export function isValidExternalKey(key: string): boolean {
  if (!EXTERNAL_API_KEY) return false;
  return !!key && safeEqual(key, EXTERNAL_API_KEY);
}

/** Express middleware guarding every external gateway route. */
export function requireExternalApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!externalAuthConfigured()) {
    console.error("[external] EXTERNAL_API_KEY is not set; refusing external requests.");
    res.status(503).json({ error: "External API authentication is not configured" });
    return;
  }

  const key = (req.header("x-api-key") ?? "").trim();
  if (!isValidExternalKey(key)) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }

  next();
}
