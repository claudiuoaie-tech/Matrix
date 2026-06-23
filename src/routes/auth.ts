import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { sendSms } from "../lib/twilio";
import {
  createSession,
  generateOtp,
  otpExpiry,
} from "../lib/auth";
import { adminAuthConfigured, isValidAdminKey } from "../lib/adminAuth";

export const authRouter = Router();

// In dev we surface the OTP in the API response so the frictionless login flow
// can be demoed without a real handset. Never enable this in production.
const EXPOSE_OTP =
  (process.env.EXPOSE_OTP_IN_RESPONSE ?? "true").toLowerCase() !== "false";

function normalisePhone(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

/**
 * POST /api/auth/otp/request
 * Body: { phone }
 * Generates a 6-digit code and "sends" it via Twilio SMS. Always returns ok to
 * avoid leaking which numbers are registered.
 */
authRouter.post("/otp/request", async (req: Request, res: Response): Promise<void> => {
  const phone = normalisePhone(String(req.body?.phone ?? ""));
  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const worker = await prisma.worker.findUnique({ where: { phone } });

  // Only actually generate/send a code for a known, active worker.
  let devCode: string | undefined;
  if (worker && worker.status === "ACTIVE") {
    const code = generateOtp();
    await prisma.otpCode.create({
      data: { phone, code, expiresAt: otpExpiry() },
    });
    await sendSms(
      phone,
      `Your Matrix login code is ${code}. It expires in 10 minutes.`
    );
    if (EXPOSE_OTP) devCode = code;
  }

  res.json({ ok: true, ...(devCode ? { devCode } : {}) });
});

/**
 * POST /api/auth/otp/verify
 * Body: { phone, code }
 * Validates the most recent unconsumed code and issues a session token.
 */
authRouter.post("/otp/verify", async (req: Request, res: Response): Promise<void> => {
  const phone = normalisePhone(String(req.body?.phone ?? ""));
  const code = String(req.body?.code ?? "").trim();

  if (!phone || !code) {
    res.status(400).json({ error: "phone and code are required" });
    return;
  }

  const worker = await prisma.worker.findUnique({ where: { phone } });
  if (!worker || worker.status !== "ACTIVE") {
    res.status(403).json({ error: "Account not found or inactive" });
    return;
  }

  const otp = await prisma.otpCode.findFirst({
    where: { phone, code, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    res.status(401).json({ error: "Invalid or expired code" });
    return;
  }

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumed: true },
  });

  const token = await createSession(worker.id);

  res.json({
    token,
    worker: {
      id: worker.id,
      name: worker.name,
      phone: worker.phone,
      clientPool: worker.clientPool,
    },
  });
});

/**
 * POST /api/auth/admin/login
 * Body: { key }
 * Validates the shared admin access key. The frontend stores the key on success
 * and sends it on every admin request; this endpoint just gives the login form
 * immediate pass/fail feedback.
 */
authRouter.post("/admin/login", (req: Request, res: Response): void => {
  if (!adminAuthConfigured()) {
    res.status(503).json({ error: "Admin authentication is not configured" });
    return;
  }
  const key = String(req.body?.key ?? "");
  if (!isValidAdminKey(key)) {
    res.status(401).json({ error: "Invalid admin key" });
    return;
  }
  res.json({ ok: true });
});

/** POST /api/auth/logout — invalidate the presented session token. */
authRouter.post("/logout", async (req: Request, res: Response): Promise<void> => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
  }
  res.json({ ok: true });
});
