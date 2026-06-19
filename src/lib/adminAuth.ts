import { timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Shared-secret admin authentication. The operations team authenticates with a
 * single access key (ADMIN_API_KEY). It is sent either as a Bearer token /
 * `x-admin-key` header on normal requests, or — because the EventSource API
 * cannot set headers — as a `?key=` query param on the SSE stream.
 */

const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "";

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** True if the supplied key matches the configured admin key. */
export function isValidAdminKey(key: string): boolean {
  if (!ADMIN_API_KEY) return false;
  return !!key && safeEqual(key, ADMIN_API_KEY);
}

/** Whether an admin key has been configured at all. */
export function adminAuthConfigured(): boolean {
  return ADMIN_API_KEY.length > 0;
}

/** Extract the presented key from headers or the `key` query param. */
function extractKey(req: Request): string {
  const header = req.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const xKey = req.header("x-admin-key");
  if (xKey) return xKey.trim();
  if (typeof req.query.key === "string") return req.query.key;
  return "";
}

/** Express middleware guarding every admin route. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!adminAuthConfigured()) {
    console.error("[admin] ADMIN_API_KEY is not set; refusing admin requests.");
    res.status(503).json({ error: "Admin authentication is not configured" });
    return;
  }

  if (!isValidAdminKey(extractKey(req))) {
    res.status(401).json({ error: "Invalid or missing admin key" });
    return;
  }

  next();
}
