import { randomBytes, randomInt } from "crypto";
import { Request, Response, NextFunction } from "express";
import type { Worker } from "@prisma/client";
import { prisma } from "./prisma";

// OTP codes are short-lived; sessions last a while so workers stay logged in.
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Generate a zero-padded 6-digit numeric OTP. */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function otpExpiry(): Date {
  return new Date(Date.now() + OTP_TTL_MS);
}

/** Create and persist a fresh session for a worker, returning the token. */
export async function createSession(workerId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: {
      token,
      workerId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

/** Revoke every active session for a worker (used on suspend / deactivate). */
export async function revokeSessions(workerId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { workerId } });
}

// Express augmentation so handlers can read req.worker after authentication.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      worker?: Worker;
    }
  }
}

/**
 * Authenticate a worker from the `Authorization: Bearer <token>` header. Rejects
 * unknown / expired sessions and any worker who is no longer ACTIVE (so a
 * suspended or deactivated worker is locked out immediately).
 */
export async function requireWorker(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      res.status(401).json({ error: "Missing session token" });
      return;
    }

    const session = await prisma.session.findUnique({
      where: { token },
      include: { worker: true },
    });

    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    if (session.worker.status !== "ACTIVE") {
      // Defence in depth: revoke leftover sessions for a non-active worker.
      await revokeSessions(session.workerId);
      res.status(403).json({ error: "Account is not active" });
      return;
    }

    req.worker = session.worker;
    next();
  } catch (err) {
    console.error("[auth] requireWorker error:", err);
    res.status(500).json({ error: "Auth check failed" });
  }
}
