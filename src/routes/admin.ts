import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ClientPool, RotaStatus, DocType, MessageChannel, HolidayStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { sendSms, sendWhatsApp, sendMessage, sendWhatsAppTemplate, toE164 } from "../lib/twilio";
import {
  getTemplate,
  resolveContentSid,
  templateCatalogForClient,
  buildTemplatePreview,
  buildTemplateValues,
} from "../lib/templates";
import { bus, emitRotaEvent, RotaEvent } from "../lib/events";
import { revokeSessions } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import { isRtwExpired } from "../lib/rtw";
import { parseCsv, buildCsv, parseFlexibleDate } from "../lib/csv";
import { fireWebhook } from "../services/webhook.service";
import { seedDemoData } from "../lib/seedDemo";
import { saveOutboundMedia } from "../lib/outboundMedia";
import {
  mondayKey,
  windowKeys,
  dateOnlyUTC,
  ymdFromUTC,
  splitName,
  formatDateUk,
} from "../lib/board";

// Uploaded document storage (created on demand).
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const DOC_TYPES: DocType[] = ["PASSPORT", "RTW", "PROOF_OF_ADDRESS", "OTHER"];
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

const ALL_ROTA_STATUSES: RotaStatus[] = [
  "AVAILABLE",
  "UNAVAILABLE",
  "SICK",
  "REST",
  "HOLIDAY",
  "SCHEDULED",
  "CANCELLED",
  "NO_SHOW",
  "REJECTED",
];

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human label like "Mon 15-Jun" from a UTC-midnight date. */
function dayLabelUTC(d: Date): string {
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()}-${SHORT_MONTHS[d.getUTCMonth()]}`;
}

/** Date-only label like "15-Jun" from a UTC-midnight date (for status SMS copy). */
function dateLabelUTC(d: Date): string {
  return `${d.getUTCDate()}-${SHORT_MONTHS[d.getUTCMonth()]}`;
}

// Statuses that NEVER trigger an admin-override SMS: workers self-manage their
// own availability, so an admin setting these shouldn't text anyone.
const SILENT_OVERRIDE_STATUSES: RotaStatus[] = ["AVAILABLE", "UNAVAILABLE"];

/**
 * The SMS body for an admin status override, or null when no text should be sent
 * (AVAILABLE / UNAVAILABLE). NO_SHOW gets a specialised warning. SCHEDULED is
 * handled separately by allocationSmsBody() (it needs the worker + client names),
 * so it never reaches here.
 */
function overrideSmsBody(status: RotaStatus, date: Date): string | null {
  if (SILENT_OVERRIDE_STATUSES.includes(status)) return null;
  const dayLabel = dateLabelUTC(date);
  if (status === "NO_SHOW") {
    return `Warning: You have been marked as a No Show for your shift on ${dayLabel}. Repeated absences may result in the termination of your assignment.`;
  }
  return `Your status for ${dayLabel} has been updated to ${status}.`;
}

/**
 * The primary shift-allocation SMS, sent the instant a worker is scheduled on the
 * rota. It asks the worker to reply 1 (CONFIRM) / 2 (REJECT), which the inbound
 * webhook maps straight back onto the board. When the shift falls on the same day
 * it's being allocated the date reads "today"; otherwise it's DD/MM/YYYY.
 */
function allocationSmsBody(
  firstName: string,
  startTime: string | null,
  date: Date,
  clientName: string
): string {
  const when = ymdFromUTC(date) === ymdFromUTC(new Date()) ? "today" : formatDateUk(date);
  const time = startTime || "your scheduled time";
  const at = clientName ? ` at ${clientName}` : "";
  return (
    `Hi ${firstName}, you have been allocated a shift at ${time}, ${when}${at}. ` +
    `Please reply 1 to CONFIRM, 2 to REJECT. Thank you, Fast Rec`
  );
}

/**
 * Default preferred channel from a raw (pre-normalisation) phone number. UK
 * numbers → SMS; everything else → WHATSAPP (international workers who rely on
 * WhatsApp). We normalise first so "07…", "+44…", "0044…" all read as UK.
 */
function defaultChannelForPhone(raw: string): MessageChannel {
  return toE164(raw).startsWith("+44") ? "SMS" : "WHATSAPP";
}

/** Coerce a request value to a valid MessageChannel, or undefined if absent/invalid. */
function parsePreferredChannel(raw: unknown): MessageChannel | undefined {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "SMS" || v === "WHATSAPP" ? (v as MessageChannel) : undefined;
}

/** Whether a phone currently has an open 24h WhatsApp customer-care window. */
async function hasOpenWhatsappWindow(phone: string): Promise<boolean> {
  const contact = await prisma.whatsappContact.findUnique({
    where: { phone: toE164(phone) },
    select: { windowExpiresAt: true },
  });
  return !!contact?.windowExpiresAt && contact.windowExpiresAt.getTime() > Date.now();
}

/**
 * Dispatch the primary shift-allocation message on the worker's preferred channel
 * (Channel Preference Hierarchy):
 *  - SMS            → free-text SMS.
 *  - WHATSAPP       → free-text WhatsApp when inside the 24h window; otherwise
 *                     fall back to the approved "Shift Confirmation" Meta template
 *                     via the Content API (so an out-of-session send never fails).
 */
async function dispatchShiftMessage(
  worker: { name: string; phone: string; preferredChannel: MessageChannel },
  body: string,
  startTime: string | null,
  date: Date,
  clientName: string
): Promise<void> {
  if (worker.preferredChannel !== "WHATSAPP") {
    await sendSms(worker.phone, body);
    return;
  }

  // WhatsApp-preferred: free-text only delivers inside the 24h window.
  if (await hasOpenWhatsappWindow(worker.phone)) {
    await sendWhatsApp(worker.phone, body);
    return;
  }

  // Out of window (or no session yet) → approved template fallback. The Shift
  // Confirmation template positions are: 1 Worker name, 2 Date, 3 Start time,
  // 4 Location (client). Worker name personalises from the worker record.
  const template = getTemplate("shift_confirmation");
  if (template) {
    const when = ymdFromUTC(date) === ymdFromUTC(new Date()) ? "today" : formatDateUk(date);
    const values = buildTemplateValues(
      template,
      { "2": when, "3": startTime ?? "", "4": clientName },
      worker.name
    );
    await sendWhatsAppTemplate(worker.phone, resolveContentSid(template), values);
    return;
  }

  // No template configured — best-effort free-text WhatsApp rather than nothing.
  await sendWhatsApp(worker.phone, body);
}

/** Dispatch the primary shift-allocation message on the worker's preferred channel. */
async function dispatchAllocation(
  worker: { name: string; phone: string; preferredChannel: MessageChannel },
  startTime: string | null,
  date: Date,
  clientName: string
): Promise<void> {
  const body = allocationSmsBody(splitName(worker.name).firstName, startTime, date, clientName);
  await dispatchShiftMessage(worker, body, startTime, date, clientName);
}

/** The reminder ("nudge") copy for a pending shift — asks the worker to confirm. */
function nudgeBody(
  firstName: string,
  startTime: string | null,
  date: Date,
  clientName: string
): string {
  const when = ymdFromUTC(date) === ymdFromUTC(new Date()) ? "today" : formatDateUk(date);
  const time = startTime ? ` at ${startTime}` : "";
  const at = clientName ? ` at ${clientName}` : "";
  return (
    `Hi ${firstName}, a reminder to confirm your shift${time}, ${when}${at}. ` +
    `Please reply 1 to CONFIRM, 2 to REJECT. Thank you, Fast Rec`
  );
}

/**
 * Send the override SMS for one cell when the status warrants it. Looks the
 * worker up for their phone number. Returns true if a text was dispatched.
 */
/**
 * Fire the outbound "NO_SHOW logged" webhook for one cell. Fire-and-forget; never
 * awaited so it can't slow or fail the request.
 */
async function fireNoShowWebhook(
  workerId: string,
  clientId: string | null,
  dateKey: string
): Promise<void> {
  const worker = await prisma.worker.findUnique({
    where: { id: workerId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!worker) return;
  let clientName: string | null = null;
  if (clientId) {
    const c = await prisma.client.findUnique({ where: { id: clientId } });
    clientName = c?.companyName ?? null;
  }
  void fireWebhook("no_show.logged", {
    workerId: worker.id,
    workerName: worker.name,
    phone: worker.phone,
    email: worker.email,
    client: clientName,
    date: dateKey,
  });
}

async function notifyStatusOverride(
  workerId: string,
  status: RotaStatus,
  date: Date,
  startTime: string | null,
  clientId: string | null = null
): Promise<boolean> {
  // Cheap gate before we touch the DB: these statuses never text the worker.
  if (SILENT_OVERRIDE_STATUSES.includes(status)) return false;
  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker) return false;

  if (status === "SCHEDULED") {
    // The allocation copy names the client, so resolve it from the cell, then
    // dispatch on the worker's preferred channel (SMS / WhatsApp / template).
    let clientName = "";
    if (clientId) {
      const c = await prisma.client.findUnique({
        where: { id: clientId },
        select: { companyName: true },
      });
      clientName = c?.companyName ?? "";
    }
    await dispatchAllocation(worker, startTime, date, clientName);
    return true;
  }

  // Non-allocation status overrides keep the existing SMS behaviour.
  const generic = overrideSmsBody(status, date);
  if (!generic) return false;
  await sendSms(worker.phone, generic);
  return true;
}

export const adminRouter = Router();

// Every admin route requires the shared admin key (header on normal requests,
// or ?key= on the SSE stream since EventSource cannot send headers).
adminRouter.use(requireAdmin);

const POOLS: ClientPool[] = ["POOL_A", "POOL_B", "POOL_C"];

// Skills are free-text competency tags. Accept either an array of strings or a
// comma-separated string; trim, drop blanks, cap length, dedupe (case-insensitive),
// and limit how many a single worker can carry.
const MAX_SKILLS = 30;
const MAX_SKILL_LEN = 40;
/** Trim + lowercase an email, or null when blank/invalid-shaped. */
function normalizeEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function sanitizeSkills(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(",")
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const s = String(item).trim().slice(0, MAX_SKILL_LEN);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Date helpers
// ----------------------------------------------------------------------------

/** Monday 00:00 of the week containing `ref` (or today). */
function weekStart(ref?: string): Date {
  const d = ref ? new Date(ref) : new Date();
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ----------------------------------------------------------------------------
// Live Rota Matrix
// ----------------------------------------------------------------------------

/**
 * GET /api/admin/rota?weekStart=YYYY-MM-DD
 * Clients (A/B/C) and their shifts for the week, each with allocation cards and
 * confirmed/needed fulfilment counts.
 */
adminRouter.get("/rota", async (req: Request, res: Response): Promise<void> => {
  const start = weekStart(
    typeof req.query.weekStart === "string" ? req.query.weekStart : undefined
  );
  const end = addDays(start, 7);

  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { companyName: "asc" },
    include: {
      shifts: {
        where: { date: { gte: start, lt: end } },
        orderBy: [{ date: "asc" }, { slot: "asc" }],
        include: {
          allocations: {
            include: { worker: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  const data = clients.map((c) => ({
    id: c.id,
    companyName: c.companyName,
    address: c.address,
    shifts: c.shifts.map((s) => {
      const confirmed = s.allocations.filter((a) => a.state === "CONFIRMED").length;
      return {
        id: s.id,
        date: s.date,
        slot: s.slot,
        startTime: s.startTime,
        endTime: s.endTime,
        slotsNeeded: s.slotsNeeded,
        confirmedCount: confirmed,
        fulfilment: `${confirmed} / ${s.slotsNeeded}`,
        allocations: s.allocations
          .filter((a) => a.state !== "AVAILABLE")
          .map((a) => ({
            id: a.id,
            state: a.state,
            workerId: a.workerId,
            workerName: a.worker.name,
          })),
      };
    }),
  }));

  res.json({ weekStart: start.toISOString(), clients: data });
});

// ----------------------------------------------------------------------------
// Worker CRUD
// ----------------------------------------------------------------------------

/** GET /api/admin/workers — every (non-deleted) worker with counts. */
adminRouter.get("/workers", async (_req: Request, res: Response): Promise<void> => {
  const workers = await prisma.worker.findMany({
    where: { deletedAt: null },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { allocations: true, holidays: true, documents: true } },
    },
  });
  res.json(workers);
});

/** POST /api/admin/workers — create a worker. */
adminRouter.post("/workers", async (req: Request, res: Response): Promise<void> => {
  const name = String(req.body?.name ?? "").trim();
  // Normalise to E.164 on the way in so "07…" and "+44…" can't create duplicate
  // records or break Twilio/login lookups later.
  const phone = toE164(String(req.body?.phone ?? ""));
  const clientPool = String(req.body?.clientPool ?? "");

  if (!name || !phone || !POOLS.includes(clientPool as ClientPool)) {
    res.status(400).json({ error: "name, phone and a valid clientPool are required" });
    return;
  }

  const existing = await prisma.worker.findUnique({ where: { phone } });
  if (existing) {
    res.status(409).json({ error: "A worker with that phone already exists" });
    return;
  }

  const email = normalizeEmail(req.body?.email);
  if (email) {
    const emailTaken = await prisma.worker.findUnique({ where: { email } });
    if (emailTaken) {
      res.status(409).json({ error: "A worker with that email already exists" });
      return;
    }
  }

  const rtwRaw = req.body?.rtwExpiryDate;
  const rtwExpiryDate = rtwRaw ? new Date(String(rtwRaw)) : null;

  // Preferred channel: an explicit choice wins; otherwise default from the number
  // (UK → SMS, international → WhatsApp).
  const preferredChannel =
    parsePreferredChannel(req.body?.preferredChannel) ??
    defaultChannelForPhone(String(req.body?.phone ?? ""));

  const worker = await prisma.worker.create({
    data: {
      name,
      phone,
      email,
      clientPool: clientPool as ClientPool,
      preferredChannel,
      rtwExpiryDate: rtwExpiryDate && !Number.isNaN(rtwExpiryDate.getTime()) ? rtwExpiryDate : null,
      skills: sanitizeSkills(req.body?.skills),
    },
  });
  emitRotaEvent({ type: "worker.updated", payload: { workerId: worker.id } });
  res.status(201).json(worker);
});

/**
 * PUT /api/admin/workers/:id — edit a worker (name/phone/pool/status).
 * Moving a worker to SUSPENDED or INACTIVE immediately revokes their sessions
 * and disconnects them from any future PROPOSED/CONFIRMED shifts.
 */
adminRouter.put("/workers/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const worker = await prisma.worker.findUnique({ where: { id } });
  if (!worker) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  const data: {
    name?: string;
    phone?: string;
    email?: string | null;
    clientPool?: ClientPool;
    status?: "ACTIVE" | "SUSPENDED" | "INACTIVE";
    preferredChannel?: MessageChannel;
    rtwExpiryDate?: Date | null;
    skills?: string[];
  } = {};

  if (req.body?.skills !== undefined) data.skills = sanitizeSkills(req.body.skills);
  if (req.body?.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (email) {
      const taken = await prisma.worker.findFirst({
        where: { email, id: { not: id } },
      });
      if (taken) {
        res.status(409).json({ error: "A worker with that email already exists" });
        return;
      }
    }
    data.email = email;
  }
  if (req.body?.name != null) data.name = String(req.body.name).trim();
  if (req.body?.phone != null) data.phone = toE164(String(req.body.phone));
  if (req.body?.clientPool != null && POOLS.includes(req.body.clientPool)) {
    data.clientPool = req.body.clientPool;
  }
  // Preferred channel: an explicit valid value overrides; ignored otherwise so a
  // blank/omitted field never clobbers the stored preference.
  const chosenChannel = parsePreferredChannel(req.body?.preferredChannel);
  if (chosenChannel) data.preferredChannel = chosenChannel;
  if (["ACTIVE", "SUSPENDED", "INACTIVE"].includes(String(req.body?.status))) {
    data.status = req.body.status;
  }
  // rtwExpiryDate: a date string sets it, null/"" clears it, undefined leaves it.
  if (req.body?.rtwExpiryDate !== undefined) {
    const v = req.body.rtwExpiryDate;
    if (!v) {
      data.rtwExpiryDate = null;
    } else {
      const d = new Date(String(v));
      if (!Number.isNaN(d.getTime())) data.rtwExpiryDate = d;
    }
  }

  const updated = await prisma.worker.update({ where: { id }, data });

  // If the worker is no longer active, lock them out and free their slots.
  if (updated.status === "SUSPENDED" || updated.status === "INACTIVE") {
    await revokeSessions(id);
    const affected = await prisma.allocation.findMany({
      where: {
        workerId: id,
        state: { in: ["PROPOSED", "CONFIRMED"] },
        shift: { date: { gte: startOfDay(new Date()) } },
      },
      select: { id: true, shiftId: true },
    });
    if (affected.length) {
      await prisma.allocation.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: { state: "DECLINED" },
      });
      for (const a of affected) {
        emitRotaEvent({
          type: "allocation.updated",
          payload: { allocationId: a.id, shiftId: a.shiftId, state: "DECLINED" },
        });
      }
    }
  }

  emitRotaEvent({ type: "worker.updated", payload: { workerId: id } });
  res.json(updated);
});

/**
 * DELETE /api/admin/workers/:id — soft-delete a worker.
 *
 * We never hard-delete: a worker's RotaCells and Allocations are the source of
 * truth for historical rota/financial reporting, so we mark `deletedAt`, flip
 * the worker INACTIVE and revoke their sessions. The worker vanishes from admin
 * lists, the board, broadcasts and login, but all history is preserved.
 */
adminRouter.delete("/workers/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const worker = await prisma.worker.findUnique({ where: { id } });
  if (!worker || worker.deletedAt) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  await prisma.worker.update({
    where: { id },
    data: { deletedAt: new Date(), status: "INACTIVE" },
  });
  await revokeSessions(id);

  // Free any upcoming proposed/confirmed slots so the shift can be re-filled.
  const affected = await prisma.allocation.findMany({
    where: {
      workerId: id,
      state: { in: ["PROPOSED", "CONFIRMED"] },
      shift: { date: { gte: startOfDay(new Date()) } },
    },
    select: { id: true, shiftId: true },
  });
  if (affected.length) {
    await prisma.allocation.updateMany({
      where: { id: { in: affected.map((a) => a.id) } },
      data: { state: "DECLINED" },
    });
    for (const a of affected) {
      emitRotaEvent({
        type: "allocation.updated",
        payload: { allocationId: a.id, shiftId: a.shiftId, state: "DECLINED" },
      });
    }
  }

  emitRotaEvent({ type: "worker.updated", payload: { workerId: id } });
  res.json({ ok: true });
});

/**
 * POST /api/admin/workers/bulk-allocate
 * Body: { workerIds: string[], clientId: string }
 * Re-points each worker's pool to the destination client's pool in one
 * transaction (used for bulk manual workflows and post-CSV-import mapping).
 */
adminRouter.post(
  "/workers/bulk-allocate",
  async (req: Request, res: Response): Promise<void> => {
    const workerIds = Array.isArray(req.body?.workerIds)
      ? req.body.workerIds.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const clientId = String(req.body?.clientId ?? "");
    if (workerIds.length === 0 || !clientId) {
      res.status(400).json({ error: "workerIds (non-empty) and clientId are required" });
      return;
    }

    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { pool: true },
    });
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const result = await prisma.worker.updateMany({
      where: { id: { in: workerIds }, deletedAt: null },
      data: { clientPool: client.pool },
    });

    emitRotaEvent({ type: "worker.updated", payload: { bulk: result.count } });
    res.json({ ok: true, updated: result.count, pool: client.pool });
  }
);

// ----------------------------------------------------------------------------
// CSV import / export
// ----------------------------------------------------------------------------

// Canonical column header -> the keys we read. Headers are matched after
// stripping non-alphanumerics and lowercasing, so "Phone Number", "phone_number"
// and "PhoneNumber" all resolve.
function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * POST /api/admin/workers/import
 * Body: { csv: string } — the raw text of the uploaded .csv file.
 * Parses rows, cleans data, upserts by phone (then email), and returns a summary.
 * Each row is wrapped in its own try/catch so one bad row never aborts the batch.
 */
adminRouter.post("/workers/import", async (req: Request, res: Response): Promise<void> => {
  const csvText = typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!csvText.trim()) {
    res.status(400).json({ error: "No CSV content provided" });
    return;
  }

  let rows: string[][];
  try {
    rows = parseCsv(csvText);
  } catch {
    res.status(400).json({ error: "Could not parse the CSV file" });
    return;
  }
  if (rows.length < 2) {
    res.status(400).json({ error: "CSV needs a header row and at least one data row" });
    return;
  }

  const header = rows[0].map(normHeader);
  const idx = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const col = {
    first: idx("firstname"),
    last: idx("lastname"),
    phone: idx("phonenumber", "phone"),
    email: idx("email"),
    rtw: idx("rtwexpirydate", "rtwexpiry", "rtw"),
    skills: idx("skills"),
  };
  if (col.phone === -1) {
    res.status(400).json({ error: "CSV must include a PhoneNumber column" });
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let expiredFlagged = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (i: number): string => (i >= 0 && i < cells.length ? String(cells[i]).trim() : "");
    const rowNum = r + 1; // 1-based incl. header, for human-friendly messages
    try {
      const name = `${get(col.first)} ${get(col.last)}`.trim();
      const phone = get(col.phone) ? toE164(get(col.phone)) : "";
      const email = normalizeEmail(get(col.email));
      const skillsRaw = get(col.skills);
      const skills = sanitizeSkills(skillsRaw);
      const rtwRaw = get(col.rtw);
      const rtwDate = parseFlexibleDate(rtwRaw);

      if (!phone) {
        skipped++;
        errors.push({ row: rowNum, reason: "Missing phone number" });
        continue;
      }
      if (!name) {
        skipped++;
        errors.push({ row: rowNum, reason: "Missing name" });
        continue;
      }
      if (rtwRaw && !rtwDate) {
        errors.push({ row: rowNum, reason: `Unrecognised date "${rtwRaw}" — left blank` });
      }

      // Duplicate detection: by phone first, then by email.
      let existing = await prisma.worker.findUnique({ where: { phone } });
      if (!existing && email) existing = await prisma.worker.findUnique({ where: { email } });

      // Never steal an email that belongs to a different worker.
      let safeEmail = email;
      if (email) {
        const owner = await prisma.worker.findUnique({ where: { email } });
        if (owner && (!existing || owner.id !== existing.id)) safeEmail = null;
      }

      if (existing) {
        await prisma.worker.update({
          where: { id: existing.id },
          data: {
            name,
            ...(safeEmail !== null ? { email: safeEmail } : {}),
            ...(rtwDate ? { rtwExpiryDate: rtwDate } : {}),
            ...(skillsRaw ? { skills } : {}),
          },
        });
        updated++;
        if (isRtwExpired(rtwDate ?? existing.rtwExpiryDate)) expiredFlagged++;
      } else {
        await prisma.worker.create({
          data: {
            name,
            phone,
            email: safeEmail,
            clientPool: "POOL_A",
            // Default channel from the imported number (UK → SMS, else WhatsApp).
            preferredChannel: defaultChannelForPhone(get(col.phone)),
            rtwExpiryDate: rtwDate,
            skills,
          },
        });
        created++;
        if (isRtwExpired(rtwDate)) expiredFlagged++;
      }
    } catch (err) {
      skipped++;
      errors.push({ row: rowNum, reason: err instanceof Error ? err.message : "Row failed" });
    }
  }

  emitRotaEvent({ type: "worker.updated", payload: { import: true, created, updated } });

  const parts = [`Successfully imported ${created} worker${created === 1 ? "" : "s"}`];
  if (updated) parts.push(`updated ${updated} existing`);
  if (skipped) parts.push(`${skipped} skipped`);
  const message = parts.join(", ") + ".";

  res.json({ ok: true, created, updated, skipped, expiredFlagged, errors, message });
});

/**
 * GET /api/admin/workers/export
 * Streams the active worker pool as a CSV string with the canonical headers.
 * Skills are flattened to a comma-separated value (auto-quoted by the serializer).
 */
adminRouter.get("/workers/export", async (_req: Request, res: Response): Promise<void> => {
  const workers = await prisma.worker.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    orderBy: { name: "asc" },
  });

  const headers = ["FirstName", "LastName", "PhoneNumber", "Email", "RTWExpiryDate", "Skills"];
  const rows = workers.map((w) => {
    const { firstName, lastName } = splitName(w.name);
    return [
      firstName,
      lastName,
      w.phone,
      w.email ?? "",
      w.rtwExpiryDate ? ymdFromUTC(w.rtwExpiryDate) : "",
      w.skills.join(", "),
    ];
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(buildCsv(headers, rows));
});

// ----------------------------------------------------------------------------
// Worker document vault (compliance uploads)
// ----------------------------------------------------------------------------

function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** GET /api/admin/workers/:id/documents — a worker's uploaded documents. */
adminRouter.get(
  "/workers/:id/documents",
  async (req: Request, res: Response): Promise<void> => {
    const docs = await prisma.workerDocument.findMany({
      where: { workerId: req.params.id },
      orderBy: { uploadedAt: "desc" },
    });
    res.json(docs);
  }
);

/**
 * POST /api/admin/workers/:id/documents
 * Body: { docType, fileName, mimeType, data } where `data` is base64 (a plain
 * string or a data: URL). Validates type/size, writes to disk under a random
 * filename (never the user-supplied name → no path traversal), records the row.
 */
adminRouter.post(
  "/workers/:id/documents",
  async (req: Request, res: Response): Promise<void> => {
    const workerId = req.params.id;
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) {
      res.status(404).json({ error: "Worker not found" });
      return;
    }

    const docType = (DOC_TYPES.includes(req.body?.docType as DocType)
      ? req.body.docType
      : "OTHER") as DocType;
    const mimeType = String(req.body?.mimeType ?? "");
    const fileName =
      String(req.body?.fileName ?? "document").trim().slice(0, 200) || "document";
    const ext = ALLOWED_MIME[mimeType];
    if (!ext) {
      res.status(415).json({ error: "Only JPEG, PNG and PDF files are allowed." });
      return;
    }

    let raw = String(req.body?.data ?? "");
    const comma = raw.indexOf(",");
    if (raw.startsWith("data:") && comma !== -1) raw = raw.slice(comma + 1);
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) {
      res.status(400).json({ error: "Empty or invalid file data" });
      return;
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "File exceeds the 15 MB limit." });
      return;
    }

    ensureUploadDir();
    const storedName = `${randomUUID()}${ext}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, storedName), buffer);

    const doc = await prisma.workerDocument.create({
      data: { workerId, docType, fileName, filePath: storedName, mimeType },
    });
    res.status(201).json(doc);
  }
);

/**
 * GET /api/admin/documents/:id/file — stream a document inline. Auth is via the
 * admin key (header or ?key=), so it works from a plain link.
 */
adminRouter.get(
  "/documents/:id/file",
  async (req: Request, res: Response): Promise<void> => {
    const doc = await prisma.workerDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const abs = path.join(UPLOAD_DIR, doc.filePath);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "File missing on disk" });
      return;
    }
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${doc.fileName.replace(/["\r\n]/g, "")}"`
    );
    fs.createReadStream(abs).pipe(res);
  }
);

/** DELETE /api/admin/documents/:id — remove a document row and its file. */
adminRouter.delete(
  "/documents/:id",
  async (req: Request, res: Response): Promise<void> => {
    const doc = await prisma.workerDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    fs.promises.unlink(path.join(UPLOAD_DIR, doc.filePath)).catch(() => {});
    await prisma.workerDocument.delete({ where: { id: doc.id } });
    res.json({ ok: true });
  }
);

// ----------------------------------------------------------------------------
// Nudge — follow-up ping for a proposed allocation
// ----------------------------------------------------------------------------

/** POST /api/admin/allocations/:id/nudge — re-send the proposal SMS. */
adminRouter.post(
  "/allocations/:id/nudge",
  async (req: Request, res: Response): Promise<void> => {
    const allocation = await prisma.allocation.findUnique({
      where: { id: req.params.id },
      include: { worker: true, shift: { include: { client: true } } },
    });

    if (!allocation) {
      res.status(404).json({ error: "Allocation not found" });
      return;
    }
    if (allocation.state !== "PROPOSED") {
      res.status(409).json({ error: `Allocation is ${allocation.state}, nothing to nudge` });
      return;
    }

    const s = allocation.shift;
    const dateStr = formatDateUk(new Date(s.date));
    await sendSms(
      allocation.worker.phone,
      `Reminder: ${s.client.companyName} still needs you for the ${s.slot} shift on ${dateStr} (${s.startTime}-${s.endTime}). Reply 1 to accept or 2 to decline.`
    );

    res.json({ ok: true, nudged: allocation.worker.name });
  }
);

// ----------------------------------------------------------------------------
// Broadcast engine
// ----------------------------------------------------------------------------

/**
 * GET /api/admin/broadcast/recipients?pool=POOL_A&date=YYYY-MM-DD
 * Candidate workers for a broadcast. Excludes non-active workers and anyone on
 * holiday on `date`. Flags whether each is already allocated for that date.
 */
adminRouter.get(
  "/broadcast/recipients",
  async (req: Request, res: Response): Promise<void> => {
    const pool = typeof req.query.pool === "string" ? req.query.pool : undefined;
    const dateStr = typeof req.query.date === "string" ? req.query.date : undefined;
    const date = dateStr ? startOfDay(new Date(dateStr)) : undefined;

    const workers = await prisma.worker.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        ...(pool && POOLS.includes(pool as ClientPool)
          ? { clientPool: pool as ClientPool }
          : {}),
      },
      orderBy: { name: "asc" },
    });

    let onHoliday = new Set<string>();
    let allocatedForDate = new Set<string>();

    if (date) {
      const nextDay = addDays(date, 1);

      const holidays = await prisma.holidayRequest.findMany({
        where: {
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: date },
          endDate: { gte: date },
        },
        select: { workerId: true },
      });
      onHoliday = new Set(holidays.map((h) => h.workerId));

      const allocs = await prisma.allocation.findMany({
        where: {
          state: { in: ["PROPOSED", "CONFIRMED"] },
          shift: { date: { gte: date, lt: nextDay } },
        },
        select: { workerId: true },
      });
      allocatedForDate = new Set(allocs.map((a) => a.workerId));
    }

    res.json(
      workers
        // A worker on holiday is never a valid candidate.
        .filter((w) => !onHoliday.has(w.id))
        .map((w) => ({
          id: w.id,
          name: w.name,
          phone: w.phone,
          clientPool: w.clientPool,
          allocatedForDate: allocatedForDate.has(w.id),
        }))
    );
  }
);

/**
 * POST /api/admin/broadcast
 * Body: { messageBody, workerIds: string[], shiftId?: string }
 * Sends the SMS to each worker, writes a BroadcastLog, and — when a shiftId is
 * supplied — creates PROPOSED allocations so replies flow through the webhook.
 */
adminRouter.post("/broadcast", async (req: Request, res: Response): Promise<void> => {
  const messageBody = String(req.body?.messageBody ?? "").trim();
  const workerIds: string[] = Array.isArray(req.body?.workerIds)
    ? req.body.workerIds.map(String)
    : [];
  const shiftId = req.body?.shiftId ? String(req.body.shiftId) : undefined;
  const channel = req.body?.channel === "WHATSAPP" ? "WHATSAPP" : "SMS";

  if (!messageBody) {
    res.status(400).json({ error: "messageBody is required" });
    return;
  }
  if (workerIds.length === 0) {
    res.status(400).json({ error: "At least one recipient is required" });
    return;
  }

  const workers = await prisma.worker.findMany({
    where: { id: { in: workerIds }, status: "ACTIVE", deletedAt: null },
  });

  // Dispatch to every recipient on the chosen channel (SMS or WhatsApp), both
  // via Twilio.
  await Promise.all(workers.map((w) => sendMessage(w.phone, messageBody, channel)));

  // Optionally seed PROPOSED allocations for a specific shift.
  let proposed = 0;
  if (shiftId) {
    const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
    if (shift) {
      for (const w of workers) {
        const alloc = await prisma.allocation.upsert({
          where: { shiftId_workerId: { shiftId, workerId: w.id } },
          create: { shiftId, workerId: w.id, state: "PROPOSED" },
          update: { state: "PROPOSED" },
        });
        proposed += 1;
        emitRotaEvent({
          type: "allocation.created",
          payload: { allocationId: alloc.id, shiftId, workerId: w.id, state: "PROPOSED" },
        });
      }
    }
  }

  const log = await prisma.broadcastLog.create({
    data: { messageBody, recipients: workers.map((w) => w.id) },
  });

  emitRotaEvent({
    type: "broadcast.sent",
    payload: { broadcastId: log.id, recipientCount: workers.length, proposed },
  });

  res.status(201).json({
    ok: true,
    broadcastId: log.id,
    sent: workers.length,
    proposed,
    channel,
  });
});

// ----------------------------------------------------------------------------
// Demo seed (idempotent, safe for production)
// ----------------------------------------------------------------------------

/**
 * POST /api/admin/seed — populate demo data, but ONLY when the database is empty
 * (never deletes existing data). Lets an operator seed a fresh deployment without
 * shell access. Returns 200 with a skip message if data already exists.
 */
adminRouter.post("/seed", async (_req: Request, res: Response): Promise<void> => {
  const result = await seedDemoData();
  res.status(result.seeded ? 201 : 200).json(result);
});

// ----------------------------------------------------------------------------
// Live Inbox — inbound SMS / WhatsApp messages
// ----------------------------------------------------------------------------

/**
 * GET /api/admin/messages?limit=100
 * Recent inbound messages, newest first, with the matched worker's name resolved.
 */
adminRouter.get("/messages", async (req: Request, res: Response): Promise<void> => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const messages = await prisma.incomingMessage.findMany({
    orderBy: { receivedAt: "desc" },
    take: limit,
    include: { worker: { select: { name: true } } },
  });

  // Unread only counts inbound messages — our own outbound replies are logged as
  // already-read, so they never inflate the badge.
  const unread = await prisma.incomingMessage.count({ where: { isRead: false } });

  // Open WhatsApp windows: phone → ISO expiry, for contacts still inside their
  // 24h customer-care window. The UI uses this to decide whether a WhatsApp
  // thread allows free-text (in window) or only approved templates (expired).
  const openContacts = await prisma.whatsappContact.findMany({
    where: { windowExpiresAt: { gt: new Date() } },
    select: { phone: true, windowExpiresAt: true },
  });
  const windows: Record<string, string> = {};
  for (const c of openContacts) {
    if (c.windowExpiresAt) windows[c.phone] = c.windowExpiresAt.toISOString();
  }

  res.json({
    unread,
    windows,
    messages: messages.map((m) => ({
      id: m.id,
      fromNumber: m.fromNumber,
      messageBody: m.messageBody,
      channel: m.channel,
      direction: m.direction,
      mediaUrl: m.mediaUrl,
      receivedAt: m.receivedAt.toISOString(),
      isRead: m.isRead,
      workerName: m.worker?.name ?? null,
      deliveryStatus: m.deliveryStatus,
    })),
  });
});

/**
 * GET /api/admin/messages/:id/media — proxy an inbound media attachment.
 *
 * Twilio MMS / WhatsApp media URLs are private (they require the account's
 * SID + Auth Token), so they cannot be embedded directly in an <img>. We fetch
 * the stored mediaUrl server-side with Basic Auth and stream the bytes back.
 * Auth is via the admin key (header or ?key=), so it works from a plain <img>.
 */
adminRouter.get(
  "/messages/:id/media",
  async (req: Request, res: Response): Promise<void> => {
    const msg = await prisma.incomingMessage.findUnique({
      where: { id: req.params.id },
      select: { mediaUrl: true },
    });
    if (!msg?.mediaUrl) {
      res.status(404).json({ error: "No media for this message" });
      return;
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const headers: Record<string, string> = {};
    // Authenticate the upstream fetch for Twilio-hosted media. (On the cross-
    // origin redirect to Twilio's CDN, fetch drops the auth header automatically.)
    if (sid && token && /(?:^|\.)twilio\.com\//.test(msg.mediaUrl)) {
      headers.Authorization = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
    }

    try {
      const upstream = await fetch(msg.mediaUrl, { headers });
      if (!upstream.ok) {
        res.status(502).json({ error: `Upstream media fetch failed (${upstream.status})` });
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(buf);
    } catch (err) {
      console.error("[media proxy] fetch failed:", err);
      res.status(502).json({ error: "Could not load media" });
    }
  }
);

/** POST /api/admin/messages/read-all — mark every inbound message as read. */
adminRouter.post(
  "/messages/read-all",
  async (_req: Request, res: Response): Promise<void> => {
    const result = await prisma.incomingMessage.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true, updated: result.count });
  }
);

/**
 * POST /api/admin/messages/read-thread — mark one conversation as read.
 * Body: { phone: string }. Fired when an admin opens a thread, so unread clears
 * per-conversation without forcing the global "Mark all read". The thread key is
 * the contact's number (fromNumber); we match it verbatim and also on its E.164
 * form so a differently-formatted caller still clears the right thread.
 */
adminRouter.post(
  "/messages/read-thread",
  async (req: Request, res: Response): Promise<void> => {
    const phone = String(req.body?.phone ?? "").trim();
    if (!phone) {
      res.status(400).json({ error: "phone is required" });
      return;
    }
    const keys = Array.from(new Set([phone, toE164(phone)]));
    const result = await prisma.incomingMessage.updateMany({
      where: { fromNumber: { in: keys }, isRead: false },
      data: { isRead: true },
    });
    const unread = await prisma.incomingMessage.count({ where: { isRead: false } });
    res.json({ ok: true, updated: result.count, unread });
  }
);

/** Map a "sms" | "whatsapp" body field to the MessageChannel enum (SMS default). */
function parseChannelType(raw: unknown): MessageChannel {
  return String(raw ?? "sms").toLowerCase() === "whatsapp" ? "WHATSAPP" : "SMS";
}

/**
 * Resolve an optional outbound attachment (a `{ data }` base64 data URL in the
 * request body) into a public URL Twilio can fetch. Returns `{ error }` for an
 * unsupported / oversized file so the caller can 400.
 */
function resolveOutboundMediaUrl(media: unknown): { url: string | null; error?: string } {
  if (!media || typeof media !== "object") return { url: null };
  const data = (media as { data?: unknown }).data;
  if (typeof data !== "string" || !data) return { url: null };
  const saved = saveOutboundMedia(data);
  if (!saved) {
    return { url: null, error: "Unsupported or oversized attachment (images & PDF up to 5 MB)." };
  }
  return { url: saved.publicUrl };
}

/**
 * Send an outbound SMS/WhatsApp message and log it to the inbox as an OUTBOUND,
 * already-read row so it threads with the contact and never inflates "unread".
 * Works for ANY number — links to a Worker by phone when one matches, otherwise
 * logs the bare number. Shared by /messages/reply and /messages/send-direct.
 */
async function sendOutboundMessage(
  phone: string,
  body: string,
  channel: MessageChannel,
  mediaUrl: string | null
) {
  // Send via Twilio (mock-logs without real creds; never throws on a bad number).
  // A genuine rejection must fail loudly here — otherwise we'd log a phantom
  // "sent" row and the admin UI would report success for a message that never
  // left Twilio.
  const result = await sendMessage(phone, body, channel, mediaUrl ? [mediaUrl] : undefined);
  if (!result.ok) {
    throw new HttpError(
      502,
      `${channel} send failed${result.code ? ` (Twilio ${result.code})` : ""}: ${
        result.message ?? "unknown error"
      }`
    );
  }

  return recordOutboundRow(phone, body, channel, mediaUrl, result.sid ?? null);
}

/**
 * Persist an already-sent OUTBOUND message to the inbox (read=true so it never
 * inflates "unread"), link it to a Worker by phone when one matches, and emit
 * the real-time event. Shared by free-form sends and template sends.
 */
async function recordOutboundRow(
  phone: string,
  body: string,
  channel: MessageChannel,
  mediaUrl: string | null,
  providerSid: string | null = null
) {
  const worker = await prisma.worker.findUnique({
    where: { phone },
    select: { id: true, name: true },
  });

  const msg = await prisma.incomingMessage.create({
    data: {
      fromNumber: phone, // the contact's number = the thread key
      messageBody: body,
      channel,
      direction: "OUTBOUND",
      workerId: worker?.id ?? null,
      isRead: true,
      mediaUrl,
      providerSid,
      // A real accepted send starts at "sent" (single tick); the Twilio status
      // callback later upgrades it to delivered/read. Mock sends stay null.
      deliveryStatus: providerSid ? "sent" : null,
    },
  });

  const payload = {
    id: msg.id,
    fromNumber: msg.fromNumber,
    messageBody: msg.messageBody,
    channel: msg.channel,
    direction: msg.direction,
    mediaUrl: msg.mediaUrl,
    receivedAt: msg.receivedAt.toISOString(),
    isRead: msg.isRead,
    workerName: worker?.name ?? null,
    deliveryStatus: msg.deliveryStatus,
  };

  // Push to any other connected admin dashboards in real time.
  emitRotaEvent({ type: "message.received", payload });
  return payload;
}

/**
 * POST /api/admin/messages/reply
 * Reply to an existing contact/thread. Body:
 *   { recipientPhone: string, messageBody: string, channelType: "sms" | "whatsapp" }
 */
adminRouter.post(
  "/messages/reply",
  async (req: Request, res: Response): Promise<void> => {
    const recipientPhone = String(req.body?.recipientPhone ?? "").trim();
    const messageBody = String(req.body?.messageBody ?? "").trim();
    const media = resolveOutboundMediaUrl(req.body?.media);
    if (media.error) {
      res.status(400).json({ error: media.error });
      return;
    }
    if (!recipientPhone || (!messageBody && !media.url)) {
      res.status(400).json({ error: "recipientPhone and a message or attachment are required." });
      return;
    }
    try {
      const message = await sendOutboundMessage(
        recipientPhone,
        messageBody,
        parseChannelType(req.body?.channelType),
        media.url
      );
      res.status(201).json({ ok: true, message });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
);

/**
 * POST /api/admin/messages/send-direct
 * Send an ad-hoc message to ANY number, whether or not it matches a worker. Body:
 *   { phoneNumber: string, messageBody: string, channelType: "sms" | "whatsapp" }
 */
adminRouter.post(
  "/messages/send-direct",
  async (req: Request, res: Response): Promise<void> => {
    const phoneNumber = String(req.body?.phoneNumber ?? "").trim();
    const messageBody = String(req.body?.messageBody ?? "").trim();
    const media = resolveOutboundMediaUrl(req.body?.media);
    if (media.error) {
      res.status(400).json({ error: media.error });
      return;
    }
    if (!phoneNumber || (!messageBody && !media.url)) {
      res.status(400).json({ error: "phoneNumber and a message or attachment are required." });
      return;
    }
    try {
      const message = await sendOutboundMessage(
        phoneNumber,
        messageBody,
        parseChannelType(req.body?.channelType),
        media.url
      );
      res.status(201).json({ ok: true, message });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
);

/**
 * GET /api/admin/templates — the approved WhatsApp template catalog for the
 * out-of-session dropdown. Secret-free (Content SIDs stay server-side): just
 * display name, key, and the editable positional variables.
 */
adminRouter.get("/templates", (_req: Request, res: Response): void => {
  res.json({ templates: templateCatalogForClient() });
});

/**
 * POST /api/admin/messages/send-template — send an approved Meta template via
 * Twilio's Content API to ANY number, in or out of the 24h window. Body:
 *   { phoneNumber: string, templateKey: string, variables: { "1": "...", ... } }
 * Used for cold recruitment + out-of-session worker notifications.
 */
adminRouter.post(
  "/messages/send-template",
  async (req: Request, res: Response): Promise<void> => {
    const phoneNumber = String(req.body?.phoneNumber ?? "").trim();
    const templateKey = String(req.body?.templateKey ?? "").trim();
    const rawVars = req.body?.variables;

    if (!phoneNumber) {
      res.status(400).json({ error: "phoneNumber is required." });
      return;
    }
    const template = getTemplate(templateKey);
    if (!template) {
      res.status(400).json({ error: `Unknown template "${templateKey}".` });
      return;
    }

    // Personalise the worker-name slot from the matched worker; every other slot
    // is exactly what the admin typed (a cleared field sends blank — we never
    // fall back to the catalog sample).
    const worker = await prisma.worker.findUnique({
      where: { phone: toE164(phoneNumber) },
      select: { name: true },
    });
    const overrides =
      rawVars && typeof rawVars === "object" ? (rawVars as Record<string, unknown>) : {};
    const values = buildTemplateValues(template, overrides, worker?.name);

    const result = await sendWhatsAppTemplate(phoneNumber, resolveContentSid(template), values);
    if (!result.ok) {
      res.status(502).json({
        error: `Template send failed${result.code ? ` (Twilio ${result.code})` : ""}: ${
          result.message ?? "unknown error"
        }`,
      });
      return;
    }

    // Log a readable preview to the thread (we don't have the approved body text).
    const message = await recordOutboundRow(
      phoneNumber,
      buildTemplatePreview(template, values),
      "WHATSAPP",
      null,
      result.sid ?? null
    );
    res.status(201).json({ ok: true, message });
  }
);

/**
 * Run `fn` over `items` with a bounded concurrency `limit` (a worker pool, not a
 * single Promise.all). Keeps results positionally aligned with the input. Lets a
 * mass dispatch fire many Twilio requests concurrently without opening hundreds
 * of sockets at once or blocking the event loop.
 */
async function mapThrottled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const pool = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}

/** Per-recipient outcome of a bulk dispatch. */
interface BulkResultRow {
  phone: string;
  ok: boolean;
  code?: string | number;
  error?: string;
}

/**
 * POST /api/admin/messages/send-bulk — fan a message out to many recipients.
 * Recipients are normalised to E.164 and de-duplicated. Two modes:
 *
 *  - Template mode (body has `templateKey` [+ optional `variables` overrides]):
 *    approved-template fan-out via the Content API, in OR out of the 24h window.
 *    Per recipient the worker-name slot is personalised from the matched Worker.
 *  - Free-text mode (body has `messageBody`/`media`, `channelType`): SMS goes to
 *    everyone; WhatsApp is gated per number by the 24h window, failing
 *    out-of-window recipients with a reason to use a template.
 *
 * Both dispatch through the bounded mapThrottled() pool and return a per-number
 * result array + the logged OUTBOUND rows for the successes.
 */
adminRouter.post(
  "/messages/send-bulk",
  async (req: Request, res: Response): Promise<void> => {
    const rawRecipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    const messageBody = String(req.body?.messageBody ?? "").trim();
    const channel = parseChannelType(req.body?.channelType);
    const media = resolveOutboundMediaUrl(req.body?.media);
    if (media.error) {
      res.status(400).json({ error: media.error });
      return;
    }

    // Normalise + de-dupe to E.164 (also the inbox thread key, so bulk sends
    // thread with inbound replies).
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const r of rawRecipients) {
      const phone = toE164(String(r ?? ""));
      if (phone && !seen.has(phone)) {
        seen.add(phone);
        recipients.push(phone);
      }
    }
    if (recipients.length === 0) {
      res.status(400).json({ error: "At least one recipient is required." });
      return;
    }
    const templateKey = String(req.body?.templateKey ?? "").trim();
    const messagesOut: Awaited<ReturnType<typeof recordOutboundRow>>[] = [];

    // ---- Bulk-template mode (out-of-session WhatsApp) ---------------------
    // Approved-template fan-out: works in OR out of the 24h window, so it's the
    // path for cold recruits and dormant workers. Per recipient, the worker-name
    // slot is personalised from the matched Worker; other variables use the
    // admin's global overrides (else the template sample).
    if (templateKey) {
      const template = getTemplate(templateKey);
      if (!template) {
        res.status(400).json({ error: `Unknown template "${templateKey}".` });
        return;
      }
      const contentSid = resolveContentSid(template);
      const overrides =
        req.body?.variables && typeof req.body.variables === "object"
          ? (req.body.variables as Record<string, unknown>)
          : {};

      const workers = await prisma.worker.findMany({
        where: { phone: { in: recipients } },
        select: { phone: true, name: true },
      });
      const nameByPhone = new Map(workers.map((w) => [w.phone, w.name]));

      const results = await mapThrottled<string, BulkResultRow>(recipients, 8, async (phone) => {
        try {
          const values = buildTemplateValues(template, overrides, nameByPhone.get(phone));
          const send = await sendWhatsAppTemplate(phone, contentSid, values);
          if (!send.ok) return { phone, ok: false, code: send.code, error: send.message };
          const row = await recordOutboundRow(
            phone,
            buildTemplatePreview(template, values),
            "WHATSAPP",
            null,
            send.sid ?? null
          );
          messagesOut.push(row);
          return { phone, ok: true };
        } catch (err) {
          return {
            phone,
            ok: false,
            error: err instanceof Error ? err.message : "Template send failed",
          };
        }
      });
      const sent = results.filter((r) => r.ok).length;
      res.status(201).json({
        ok: true,
        sent,
        failed: results.length - sent,
        results,
        messages: messagesOut,
      });
      return;
    }

    // ---- Free-text mode ---------------------------------------------------
    if (!messageBody && !media.url) {
      res.status(400).json({ error: "A message or attachment is required." });
      return;
    }

    // WhatsApp: which recipients are currently inside their 24h window?
    let inWindow = new Set<string>();
    if (channel === "WHATSAPP") {
      const open = await prisma.whatsappContact.findMany({
        where: { phone: { in: recipients }, windowExpiresAt: { gt: new Date() } },
        select: { phone: true },
      });
      inWindow = new Set(open.map((c) => c.phone));
    }

    const results = await mapThrottled<string, BulkResultRow>(recipients, 8, async (phone) => {
      try {
        // Block free-text WhatsApp outside the window — enforce template routing.
        if (channel === "WHATSAPP" && !inWindow.has(phone)) {
          return {
            phone,
            ok: false,
            error: "Outside the 24-hour window — send an approved template instead.",
          };
        }
        const send = await sendMessage(
          phone,
          messageBody,
          channel,
          media.url ? [media.url] : undefined
        );
        if (!send.ok) {
          return { phone, ok: false, code: send.code, error: send.message };
        }
        const row = await recordOutboundRow(phone, messageBody, channel, media.url ?? null, send.sid ?? null);
        messagesOut.push(row);
        return { phone, ok: true };
      } catch (err) {
        return { phone, ok: false, error: err instanceof Error ? err.message : "Send failed" };
      }
    });

    const sent = results.filter((r) => r.ok).length;
    res.status(201).json({
      ok: true,
      sent,
      failed: results.length - sent,
      results,
      messages: messagesOut,
    });
  }
);

/**
 * DELETE /api/admin/messages/clear-read — bulk-delete all read messages.
 * Declared BEFORE the :id route so "clear-read" isn't captured as an id.
 */
adminRouter.delete(
  "/messages/clear-read",
  async (_req: Request, res: Response): Promise<void> => {
    const result = await prisma.incomingMessage.deleteMany({ where: { isRead: true } });
    res.json({ ok: true, deleted: result.count });
  }
);

/**
 * DELETE /api/admin/messages/bulk — batch-delete by an array of ids.
 * Body: { ids: string[] }. Declared BEFORE the :id route so "bulk" isn't
 * captured as an id.
 */
adminRouter.delete(
  "/messages/bulk",
  async (req: Request, res: Response): Promise<void> => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "ids must be a non-empty array of message ids." });
      return;
    }
    const result = await prisma.incomingMessage.deleteMany({
      where: { id: { in: ids } },
    });
    res.json({ ok: true, deleted: result.count });
  }
);

/** DELETE /api/admin/messages/:id — delete a single message. */
adminRouter.delete(
  "/messages/:id",
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    try {
      await prisma.incomingMessage.delete({ where: { id } });
    } catch {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    res.json({ ok: true });
  }
);

// ----------------------------------------------------------------------------
// Clients (for the board filter dropdown)
// ----------------------------------------------------------------------------

/**
 * GET /api/admin/clients — active clients with pool, phone and a live count of
 * the workers currently in each client's pool.
 */
adminRouter.get("/clients", async (_req: Request, res: Response): Promise<void> => {
  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { companyName: "asc" },
    select: { id: true, companyName: true, address: true, phone: true, pool: true },
  });

  // Worker headcount per pool (non-deleted) → attach to each client.
  const grouped = await prisma.worker.groupBy({
    by: ["clientPool"],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const poolCount = new Map(grouped.map((g) => [g.clientPool, g._count._all]));

  res.json(
    clients.map((c) => ({ ...c, workerCount: poolCount.get(c.pool) ?? 0 }))
  );
});

/** POST /api/admin/clients — create a client (name, address, phone, pool). */
adminRouter.post("/clients", async (req: Request, res: Response): Promise<void> => {
  const companyName = String(req.body?.companyName ?? "").trim();
  const address = String(req.body?.address ?? "").trim();
  const phone = req.body?.phone != null ? String(req.body.phone).trim() : "";
  const poolRaw = String(req.body?.pool ?? "POOL_A");
  if (!companyName || !address) {
    res.status(400).json({ error: "companyName and address are required" });
    return;
  }
  const pool = POOLS.includes(poolRaw as ClientPool) ? (poolRaw as ClientPool) : "POOL_A";

  const client = await prisma.client.create({
    data: { companyName, address, phone: phone || null, pool },
  });
  res.status(201).json(client);
});

/** PUT /api/admin/clients/:id — edit name, address, phone and/or pool. */
adminRouter.put("/clients/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const data: {
    companyName?: string;
    address?: string;
    phone?: string | null;
    pool?: ClientPool;
  } = {};
  if (req.body?.companyName != null) {
    const v = String(req.body.companyName).trim();
    if (v) data.companyName = v;
  }
  if (req.body?.address != null) {
    const v = String(req.body.address).trim();
    if (v) data.address = v;
  }
  if (req.body?.phone !== undefined) {
    const v = String(req.body.phone ?? "").trim();
    data.phone = v || null;
  }
  if (req.body?.pool != null && POOLS.includes(req.body.pool)) {
    data.pool = req.body.pool;
  }

  const updated = await prisma.client.update({ where: { id }, data });
  res.json(updated);
});

/**
 * DELETE /api/admin/clients/:id — delete a client, with a strict safety check:
 * refuse (409) if any shifts are still assigned to them so historical/active
 * rota data is never silently cascaded away.
 */
adminRouter.delete("/clients/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const shiftCount = await prisma.shift.count({ where: { clientId: id } });
  if (shiftCount > 0) {
    res.status(409).json({
      error: `Cannot delete: ${shiftCount} shift${
        shiftCount === 1 ? " is" : "s are"
      } still assigned to this client. Reassign or remove them first.`,
    });
    return;
  }

  // No shifts → safe to remove. RotaCell.clientId is SetNull on delete, so any
  // board cells referencing this client are nullified rather than destroyed.
  await prisma.client.delete({ where: { id } });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Planning board (14-day spreadsheet grid)
// ----------------------------------------------------------------------------

interface CellPayload {
  id: string;
  status: RotaStatus;
  confirmed: boolean;
  label: string | null;
  startTime: string | null;
  endTime: string | null;
  clientId: string | null;
}

/**
 * GET /api/admin/board?clientId=&start=YYYY-MM-DD
 * Returns the 14-day window (Monday-anchored) of worker rows + their cells.
 * When clientId is given, only workers in that client's pool are returned.
 */
adminRouter.get("/board", async (req: Request, res: Response): Promise<void> => {
  const startKey = mondayKey(
    typeof req.query.start === "string" ? req.query.start : undefined
  );
  const keys = windowKeys(startKey, 15); // 15th key = exclusive end
  const days = keys.slice(0, 14);
  const start = dateOnlyUTC(days[0]);
  const end = dateOnlyUTC(keys[14]);

  const clientId =
    typeof req.query.clientId === "string" && req.query.clientId
      ? req.query.clientId
      : undefined;

  let client: { id: string; companyName: string; pool: ClientPool } | null = null;
  if (clientId) {
    const c = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, companyName: true, pool: true },
    });
    client = c;
  }

  const workers = await prisma.worker.findMany({
    where: {
      status: { in: ["ACTIVE", "SUSPENDED"] },
      deletedAt: null,
      ...(client ? { clientPool: client.pool } : {}),
    },
    orderBy: { name: "asc" },
  });

  const cells = await prisma.rotaCell.findMany({
    where: {
      workerId: { in: workers.map((w) => w.id) },
      date: { gte: start, lt: end },
    },
  });

  const byWorker = new Map<string, Record<string, CellPayload>>();
  for (const c of cells) {
    const key = ymdFromUTC(c.date);
    const row = byWorker.get(c.workerId) ?? {};
    row[key] = {
      id: c.id,
      status: c.status,
      confirmed: c.confirmed,
      label: c.label,
      startTime: c.startTime,
      endTime: c.endTime,
      clientId: c.clientId,
    };
    byWorker.set(c.workerId, row);
  }

  res.json({
    startDate: days[0],
    days,
    client,
    workers: workers.map((w) => {
      const { firstName, lastName } = splitName(w.name);
      return {
        id: w.id,
        name: w.name,
        firstName,
        lastName,
        clientPool: w.clientPool,
        status: w.status,
        skills: w.skills,
        cells: byWorker.get(w.id) ?? {},
      };
    }),
  });
});

interface CellInput {
  workerId: string;
  date: string;
  status: RotaStatus;
  label?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  clientId?: string | null;
}

/** Coerce a value to a non-empty string, or null. Guards against non-string
 * inputs (objects/numbers) reaching Prisma, which would otherwise throw and crash
 * the request. */
function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function validateCellInput(c: unknown): CellInput | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.workerId !== "string" || typeof o.date !== "string") return null;
  if (!ALL_ROTA_STATUSES.includes(o.status as RotaStatus)) return null;
  // A scheduled shift needs at least a start time OR a name/label.
  if (o.status === "SCHEDULED" && !o.startTime && !o.label) return null;
  return {
    workerId: o.workerId,
    date: o.date,
    status: o.status as RotaStatus,
    label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : null,
    startTime: asStringOrNull(o.startTime),
    endTime: asStringOrNull(o.endTime),
    clientId: asStringOrNull(o.clientId),
  };
}

async function upsertCell(c: CellInput) {
  const date = dateOnlyUTC(c.date);
  return prisma.rotaCell.upsert({
    where: { workerId_date: { workerId: c.workerId, date } },
    create: {
      workerId: c.workerId,
      date,
      status: c.status,
      // Admin-set shifts start pending until the worker confirms via SMS.
      confirmed: false,
      label: c.label ?? null,
      startTime: c.startTime ?? null,
      endTime: c.endTime ?? null,
      clientId: c.clientId ?? null,
    },
    update: {
      status: c.status,
      confirmed: false,
      label: c.label ?? null,
      startTime: c.startTime ?? null,
      endTime: c.endTime ?? null,
      clientId: c.clientId ?? null,
    },
  });
}

/**
 * Names of workers (from the given ids) whose Right to Work has expired. Used to
 * block scheduling expired workers.
 */
async function rtwExpiredNames(workerIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(workerIds));
  if (ids.length === 0) return [];
  const workers = await prisma.worker.findMany({
    where: { id: { in: ids } },
    select: { name: true, rtwExpiryDate: true },
  });
  return workers.filter((w) => isRtwExpired(w.rtwExpiryDate)).map((w) => w.name);
}

/** PUT /api/admin/board/cell — set a single cell (status / start time / template). */
adminRouter.put("/board/cell", async (req: Request, res: Response): Promise<void> => {
  const input = validateCellInput(req.body);
  if (!input) {
    res.status(400).json({ error: "Invalid cell (workerId, date, status required)" });
    return;
  }

  // RTW gatekeeper: never allocate a shift to a worker with expired Right to Work.
  if (input.status === "SCHEDULED" && (await rtwExpiredNames([input.workerId])).length) {
    res.status(422).json({ error: "Cannot allocate shift: Worker's Right to Work has expired." });
    return;
  }

  // `silent: true` bypasses the SMS queue entirely (manual data correction).
  const silent = req.body?.silent === true;
  const cell = await upsertCell(input);
  const smsSent = silent
    ? false
    : await notifyStatusOverride(
        input.workerId,
        input.status,
        dateOnlyUTC(input.date),
        input.startTime ?? null,
        input.clientId ?? null
      );
  emitRotaEvent({
    type: "board.updated",
    payload: { workerId: input.workerId, date: input.date },
  });
  // Critical event fan-out: a worker logged as a NO_SHOW.
  if (input.status === "NO_SHOW") {
    void fireNoShowWebhook(input.workerId, input.clientId ?? null, input.date);
  }
  res.json({ ...cell, smsSent });
});

/**
 * PUT /api/admin/board/cells — bulk set cells (copy/paste across days/workers).
 * Body: { cells: CellInput[] }
 */
adminRouter.put("/board/cells", async (req: Request, res: Response): Promise<void> => {
  const raw = Array.isArray(req.body?.cells) ? req.body.cells : [];
  const inputs = raw.map(validateCellInput).filter((c: CellInput | null): c is CellInput => c !== null);
  if (inputs.length === 0) {
    res.status(400).json({ error: "No valid cells supplied" });
    return;
  }

  // RTW gatekeeper: block the whole batch if any SCHEDULED cell targets a worker
  // whose Right to Work has expired.
  const scheduledIds = inputs
    .filter((c: CellInput) => c.status === "SCHEDULED")
    .map((c: CellInput) => c.workerId);
  const expired = await rtwExpiredNames(scheduledIds);
  if (expired.length) {
    res.status(422).json({
      error: `Cannot allocate shift: Right to Work has expired for ${expired.join(", ")}.`,
    });
    return;
  }

  await prisma.$transaction(inputs.map((c: CellInput) => {
    const date = dateOnlyUTC(c.date);
    return prisma.rotaCell.upsert({
      where: { workerId_date: { workerId: c.workerId, date } },
      create: {
        workerId: c.workerId,
        date,
        status: c.status,
        confirmed: false,
        label: c.label ?? null,
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        clientId: c.clientId ?? null,
      },
      update: {
        status: c.status,
        confirmed: false,
        label: c.label ?? null,
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        clientId: c.clientId ?? null,
      },
    });
  }));

  // Queue one personalised text per cell whose status warrants it (AVAILABLE /
  // UNAVAILABLE stay silent). `silent: true` skips the whole queue. Sent after
  // the DB write succeeds.
  const silent = req.body?.silent === true;
  let smsSent = 0;
  if (!silent) {
    for (const c of inputs) {
      if (
        await notifyStatusOverride(
          c.workerId,
          c.status,
          dateOnlyUTC(c.date),
          c.startTime ?? null,
          c.clientId ?? null
        )
      ) {
        smsSent += 1;
      }
    }
  }

  // Critical event fan-out: any cells logged as NO_SHOW in this batch.
  for (const c of inputs) {
    if (c.status === "NO_SHOW") {
      void fireNoShowWebhook(c.workerId, c.clientId ?? null, c.date);
    }
  }

  emitRotaEvent({ type: "board.updated", payload: { bulk: inputs.length } });
  res.json({ ok: true, count: inputs.length, smsSent });
});

/** DELETE /api/admin/board/cell — clear a cell. Body: { workerId, date }. */
adminRouter.delete("/board/cell", async (req: Request, res: Response): Promise<void> => {
  const workerId = String(req.body?.workerId ?? "");
  const dateStr = String(req.body?.date ?? "");
  if (!workerId || !dateStr) {
    res.status(400).json({ error: "workerId and date are required" });
    return;
  }
  await prisma.rotaCell.deleteMany({
    where: { workerId, date: dateOnlyUTC(dateStr) },
  });
  emitRotaEvent({ type: "board.updated", payload: { workerId, date: dateStr } });
  res.json({ ok: true });
});

/** Lightweight error carrying an HTTP status, thrown inside a transaction. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * PUT /api/admin/shifts/:id/move — drag-and-drop a shift block to a new day
 * and/or worker. `:id` is the RotaCell id; body: { workerId, date }.
 *
 * rota_cells is uniquely keyed on (workerId, date), so the move runs in a
 * transaction: a blank/AVAILABLE cell already at the destination is overwritten,
 * but an occupied destination (another shift or an unavailable status) is a 409.
 * Any move resets `confirmed` to false — the relocated shift must be re-acknowledged.
 */
adminRouter.put("/shifts/:id/move", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const workerId = String(req.body?.workerId ?? "");
  const dateStr = String(req.body?.date ?? "");
  if (!workerId || !dateStr) {
    res.status(400).json({ error: "workerId and date are required" });
    return;
  }
  const date = dateOnlyUTC(dateStr);

  try {
    const moved = await prisma.$transaction(async (tx) => {
      const source = await tx.rotaCell.findUnique({ where: { id } });
      if (!source) throw new HttpError(404, "Shift not found.");

      // No-op move onto the same slot.
      if (source.workerId === workerId && ymdFromUTC(source.date) === dateStr) {
        return source;
      }

      // Reassigning a SCHEDULED shift to a worker with expired Right to Work is blocked.
      if (source.status === "SCHEDULED" && (await rtwExpiredNames([workerId])).length) {
        throw new HttpError(422, "Cannot move shift: Worker's Right to Work has expired.");
      }

      // Destination occupancy (unique workerId+date): overwrite only if blank.
      const dest = await tx.rotaCell.findUnique({
        where: { workerId_date: { workerId, date } },
      });
      if (dest && dest.id !== id) {
        const blank = dest.status === "AVAILABLE" && !dest.startTime && !dest.label;
        if (!blank) throw new HttpError(409, "That day already has a shift for this worker.");
        await tx.rotaCell.delete({ where: { id: dest.id } });
      }

      return tx.rotaCell.update({
        where: { id },
        data: { workerId, date, confirmed: false },
      });
    });

    emitRotaEvent({ type: "board.updated", payload: { workerId, date: dateStr } });
    res.json({
      ok: true,
      cell: {
        id: moved.id,
        workerId: moved.workerId,
        date: ymdFromUTC(moved.date),
        status: moved.status,
        confirmed: moved.confirmed,
        label: moved.label,
        startTime: moved.startTime,
        endTime: moved.endTime,
        clientId: moved.clientId,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[shifts/move] error:", err);
    res.status(500).json({ error: "Could not move shift." });
  }
});

/**
 * POST /api/admin/board/cancel — cancel a shift and text the worker.
 * Body: { workerId, date, clientId? }
 */
adminRouter.post("/board/cancel", async (req: Request, res: Response): Promise<void> => {
  const workerId = String(req.body?.workerId ?? "");
  const dateStr = String(req.body?.date ?? "");
  if (!workerId || !dateStr) {
    res.status(400).json({ error: "workerId and date are required" });
    return;
  }

  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  const date = dateOnlyUTC(dateStr);
  const existing = await prisma.rotaCell.findUnique({
    where: { workerId_date: { workerId, date } },
  });
  const clientId =
    (req.body?.clientId ? String(req.body.clientId) : undefined) ??
    existing?.clientId ??
    null;

  await prisma.rotaCell.upsert({
    where: { workerId_date: { workerId, date } },
    create: { workerId, date, status: "CANCELLED", clientId },
    update: { status: "CANCELLED", clientId },
  });

  // Personalised cancellation SMS.
  const first = splitName(worker.name).firstName;
  let clientName = "";
  if (clientId) {
    const c = await prisma.client.findUnique({ where: { id: clientId } });
    clientName = c?.companyName ?? "";
  }
  const label = dayLabelUTC(date);
  await sendSms(
    worker.phone,
    `Hi ${first}, your shift scheduled for ${label}${
      clientName ? ` at ${clientName}` : ""
    } has been cancelled.`
  );

  emitRotaEvent({
    type: "allocation.updated",
    payload: { workerId, date: dateStr, state: "CANCELLED" },
  });
  res.json({ ok: true, smsSent: true });
});

/**
 * POST /api/admin/board/nudge — send a reminder SMS for a SCHEDULED board cell.
 * Body: { workerId, date }
 */
adminRouter.post("/board/nudge", async (req: Request, res: Response): Promise<void> => {
  const workerId = String(req.body?.workerId ?? "");
  const dateStr = String(req.body?.date ?? "");
  if (!workerId || !dateStr) {
    res.status(400).json({ error: "workerId and date are required" });
    return;
  }

  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }

  const date = dateOnlyUTC(dateStr);
  const cell = await prisma.rotaCell.findUnique({
    where: { workerId_date: { workerId, date } },
  });
  if (!cell || cell.status !== "SCHEDULED") {
    res.status(409).json({ error: "Nothing to nudge — cell is not a scheduled shift" });
    return;
  }

  let clientName = "";
  if (cell.clientId) {
    const c = await prisma.client.findUnique({ where: { id: cell.clientId } });
    clientName = c?.companyName ?? "";
  }
  const first = splitName(worker.name).firstName;
  await sendSms(
    worker.phone,
    `Hi ${first}, a reminder about your shift on ${dayLabelUTC(date)}${
      clientName ? ` at ${clientName}` : ""
    }${cell.startTime ? ` starting ${cell.startTime}` : ""}. Reply 1 to confirm or 2 if you can't make it.`
  );

  res.json({ ok: true, nudged: worker.name });
});

/**
 * POST /api/admin/board/nudge-all — bulk-nudge every still-pending slot in the
 * currently active board view. Body: { slots: [{ workerId, date }] } (the visible
 * cells the operator is looking at). Each slot is re-validated server-side as a
 * SCHEDULED, not-yet-confirmed cell, then a reminder is dispatched on the
 * worker's preferred channel through the bounded mapThrottled pool (8 at a time).
 */
adminRouter.post("/board/nudge-all", async (req: Request, res: Response): Promise<void> => {
  const rawSlots = Array.isArray(req.body?.slots) ? req.body.slots : [];
  // Normalise + de-dupe to unique worker/date pairs.
  const seen = new Set<string>();
  const slots: { workerId: string; date: string }[] = [];
  for (const s of rawSlots) {
    const workerId = String(s?.workerId ?? "").trim();
    const date = String(s?.date ?? "").trim();
    const key = `${workerId}|${date}`;
    if (workerId && date && !seen.has(key)) {
      seen.add(key);
      slots.push({ workerId, date });
    }
  }
  if (slots.length === 0) {
    res.status(400).json({ error: "No pending slots supplied." });
    return;
  }

  const results = await mapThrottled(slots, 8, async (slot) => {
    try {
      const date = dateOnlyUTC(slot.date);
      const cell = await prisma.rotaCell.findUnique({
        where: { workerId_date: { workerId: slot.workerId, date } },
      });
      // Only nudge genuinely pending shifts (skip anything already confirmed or
      // no longer scheduled — the board the operator saw may be a little stale).
      if (!cell || cell.status !== "SCHEDULED" || cell.confirmed) {
        return { workerId: slot.workerId, date: slot.date, ok: false, error: "Not a pending shift" };
      }
      const worker = await prisma.worker.findUnique({
        where: { id: slot.workerId },
        select: { name: true, phone: true, preferredChannel: true },
      });
      if (!worker) {
        return { workerId: slot.workerId, date: slot.date, ok: false, error: "Worker not found" };
      }
      let clientName = "";
      if (cell.clientId) {
        const c = await prisma.client.findUnique({
          where: { id: cell.clientId },
          select: { companyName: true },
        });
        clientName = c?.companyName ?? "";
      }
      const body = nudgeBody(splitName(worker.name).firstName, cell.startTime, date, clientName);
      await dispatchShiftMessage(worker, body, cell.startTime, date, clientName);
      return { workerId: slot.workerId, date: slot.date, ok: true };
    } catch (err) {
      return {
        workerId: slot.workerId,
        date: slot.date,
        ok: false,
        error: err instanceof Error ? err.message : "Nudge failed",
      };
    }
  });

  const nudged = results.filter((r) => r.ok).length;
  res.json({ ok: true, nudged, failed: results.length - nudged, results });
});

/**
 * GET /api/admin/board/replacements — smart replacement suggestions for a slot
 * that just opened up (a rejection / cancellation). Query:
 *   date=YYYY-MM-DD   (required)  the shift day
 *   clientId=…        (optional)  restricts to the client's pool + names it
 *   excludeWorkerId=… (optional)  the worker who dropped out (skill template)
 *   requiredSkills=a,b(optional)  explicit client requirements (else the dropped
 *                                 worker's skills are used as the profile to match)
 *
 * Returns the top 5 eligible workers scored on three weighted criteria:
 *   1. Profile/skill match  (worker skills ∩ required skills)      × 3
 *   2. Availability that day (explicitly AVAILABLE / free)          + 2
 *   3. Reliability          (zero late cancellations preferred)     + 0..3
 */
adminRouter.get("/board/replacements", async (req: Request, res: Response): Promise<void> => {
  const dateStr = typeof req.query.date === "string" ? req.query.date : "";
  if (!dateStr) {
    res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    return;
  }
  const date = dateOnlyUTC(dateStr);
  if (Number.isNaN(date.getTime())) {
    res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
    return;
  }
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
  const excludeWorkerId =
    typeof req.query.excludeWorkerId === "string" ? req.query.excludeWorkerId : "";
  const dow = (date.getUTCDay() + 6) % 7; // 0 = Monday, matching Availability

  // Resolve the client (pool restricts the candidate set; name is for context).
  let client: { id: string; companyName: string; pool: ClientPool } | null = null;
  if (clientId) {
    client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, companyName: true, pool: true },
    });
  }

  // Required skills: explicit query wins; else mirror the dropped worker's skills
  // (find a like-for-like replacement).
  let requiredSkills = String(req.query.requiredSkills ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (requiredSkills.length === 0 && excludeWorkerId) {
    const dropped = await prisma.worker.findUnique({
      where: { id: excludeWorkerId },
      select: { skills: true },
    });
    requiredSkills = (dropped?.skills ?? []).map((s) => s.toLowerCase());
  }

  // Candidate pool: active, RTW-valid, in the client's pool, excluding the worker
  // who dropped out.
  const candidates = await prisma.worker.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      ...(client ? { clientPool: client.pool } : {}),
      ...(excludeWorkerId ? { id: { not: excludeWorkerId } } : {}),
    },
    select: { id: true, name: true, phone: true, skills: true, rtwExpiryDate: true, clientPool: true },
  });
  const eligible = candidates.filter((w) => !isRtwExpired(w.rtwExpiryDate));
  const ids = eligible.map((w) => w.id);
  if (ids.length === 0) {
    res.json({ date: dateStr, client: client?.companyName ?? null, candidates: [] });
    return;
  }

  // Batch the signals: this-day cells, holidays, weekday availability, and each
  // worker's lifetime late-cancellation (REJECTED) count.
  const [cells, holidays, availability, rejectedCounts] = await Promise.all([
    prisma.rotaCell.findMany({
      where: { workerId: { in: ids }, date },
      select: { workerId: true, status: true },
    }),
    prisma.holidayRequest.findMany({
      where: {
        workerId: { in: ids },
        status: { in: ["PENDING", "APPROVED"] },
        startDate: { lte: date },
        endDate: { gte: date },
      },
      select: { workerId: true },
    }),
    prisma.availability.findMany({
      where: { workerId: { in: ids }, dayOfWeek: dow, available: true },
      select: { workerId: true },
    }),
    prisma.rotaCell.groupBy({
      by: ["workerId"],
      where: { workerId: { in: ids }, status: "REJECTED" },
      _count: { workerId: true },
    }),
  ]);

  const cellByWorker = new Map(cells.map((c) => [c.workerId, c.status]));
  const onHoliday = new Set(holidays.map((h) => h.workerId));
  const availableWeekday = new Set(availability.map((a) => a.workerId));
  const rejectedByWorker = new Map(rejectedCounts.map((r) => [r.workerId, r._count.workerId]));

  // Statuses that make a worker unavailable to be slotted in on the day.
  const BUSY: RotaStatus[] = [
    "SCHEDULED",
    "SICK",
    "REST",
    "HOLIDAY",
    "NO_SHOW",
    "CANCELLED",
    "REJECTED",
    "UNAVAILABLE",
  ];

  const scored = eligible
    .filter((w) => !onHoliday.has(w.id))
    .filter((w) => {
      const status = cellByWorker.get(w.id);
      return !status || !BUSY.includes(status); // blank or AVAILABLE only
    })
    .map((w) => {
      const skillsLower = w.skills.map((s) => s.toLowerCase());
      const matchedSkills = requiredSkills.filter((s) => skillsLower.includes(s));
      const explicitlyAvailable =
        cellByWorker.get(w.id) === "AVAILABLE" || availableWeekday.has(w.id);
      const lateCancellations = rejectedByWorker.get(w.id) ?? 0;

      const skillScore = matchedSkills.length * 3;
      const availabilityScore = explicitlyAvailable ? 2 : 0;
      const reliabilityScore =
        lateCancellations === 0 ? 3 : lateCancellations === 1 ? 1 : 0;
      const score = skillScore + availabilityScore + reliabilityScore;

      return {
        id: w.id,
        name: w.name,
        phone: w.phone,
        skills: w.skills,
        matchedSkills,
        available: explicitlyAvailable,
        lateCancellations,
        score,
      };
    });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.lateCancellations - b.lateCancellations ||
      a.name.localeCompare(b.name)
  );

  res.json({
    date: dateStr,
    client: client?.companyName ?? null,
    requiredSkills,
    candidates: scored.slice(0, 5),
  });
});

// ----------------------------------------------------------------------------
// Holiday requests
// ----------------------------------------------------------------------------

/** Every UTC day-key (YYYY-MM-DD) from start..end inclusive (capped defensively). */
function holidayDayKeys(start: Date, end: Date): string[] {
  const DAY = 86_400_000;
  const first = dateOnlyUTC(ymdFromUTC(new Date(start))).getTime();
  const last = dateOnlyUTC(ymdFromUTC(new Date(end))).getTime();
  const keys: string[] = [];
  for (let t = first, i = 0; t <= last && i < 400; t += DAY, i++) {
    keys.push(ymdFromUTC(new Date(t)));
  }
  return keys;
}

/** Human date range for the decision SMS: "13/07/2026" or "13/07/2026–17/07/2026". */
function holidayRangeLabel(start: Date, end: Date): string {
  const a = formatDateUk(new Date(start));
  const b = formatDateUk(new Date(end));
  return a === b ? a : `${a}–${b}`;
}

/**
 * Notify a worker of a holiday decision on their preferred channel (best-effort;
 * a delivery failure must never fail the admin's action).
 */
async function notifyHolidayDecision(
  worker: { phone: string; preferredChannel: MessageChannel },
  start: Date,
  end: Date,
  approved: boolean
): Promise<void> {
  const body = `Your holiday request for ${holidayRangeLabel(start, end)} has been ${
    approved ? "Approved" : "Declined"
  } by Fast Rec.`;
  const result = await sendMessage(worker.phone, body, worker.preferredChannel);
  if (!result.ok) {
    console.error("[holiday] decision notification failed:", result.code, result.message);
  }
}

/**
 * GET /api/admin/holidays?status=PENDING — holiday requests for the admin view.
 * Omit `status` for all requests. Includes the worker's name + the reason (note).
 */
adminRouter.get("/holidays", async (req: Request, res: Response): Promise<void> => {
  const statusRaw = String(req.query.status ?? "").toUpperCase();
  const status =
    statusRaw === "PENDING" || statusRaw === "APPROVED" || statusRaw === "REJECTED"
      ? (statusRaw as HolidayStatus)
      : undefined;

  const rows = await prisma.holidayRequest.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: "desc" }],
    include: { worker: { select: { name: true } } },
  });

  res.json(
    rows.map((h) => ({
      id: h.id,
      workerId: h.workerId,
      workerName: h.worker?.name ?? null,
      startDate: ymdFromUTC(new Date(h.startDate)),
      endDate: ymdFromUTC(new Date(h.endDate)),
      status: h.status,
      reason: h.note,
      createdAt: h.createdAt.toISOString(),
    }))
  );
});

/** A conflicting active shift a holiday approval would vacate. */
interface HolidayConflict {
  date: string; // YYYY-MM-DD
  dateLabel: string; // DD/MM/YYYY
  clientName: string | null;
  startTime: string | null;
  confirmed: boolean;
}

/**
 * The worker's active shifts (SCHEDULED cells — confirmed or not) that fall within
 * the given holiday days. These are the shifts an approval would have to vacate.
 */
async function findHolidayConflicts(workerId: string, dates: Date[]): Promise<HolidayConflict[]> {
  const cells = await prisma.rotaCell.findMany({
    where: { workerId, date: { in: dates }, status: "SCHEDULED" },
    orderBy: { date: "asc" },
  });
  if (cells.length === 0) return [];

  const clientIds = [...new Set(cells.map((c) => c.clientId).filter((x): x is string => !!x))];
  const clients = clientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, companyName: true },
      })
    : [];
  const nameById = new Map(clients.map((c) => [c.id, c.companyName]));

  return cells.map((c) => ({
    date: ymdFromUTC(new Date(c.date)),
    dateLabel: formatDateUk(new Date(c.date)),
    clientName: c.clientId ? nameById.get(c.clientId) ?? null : null,
    startTime: c.startTime,
    confirmed: c.confirmed,
  }));
}

/**
 * GET /api/admin/holidays/:id/conflicts — the active shifts an approval would
 * vacate, so the UI can warn before confirming.
 */
adminRouter.get(
  "/holidays/:id/conflicts",
  async (req: Request, res: Response): Promise<void> => {
    const holiday = await prisma.holidayRequest.findUnique({
      where: { id: req.params.id },
      select: { workerId: true, startDate: true, endDate: true },
    });
    if (!holiday) {
      res.status(404).json({ error: "Holiday request not found" });
      return;
    }
    const dates = holidayDayKeys(holiday.startDate, holiday.endDate).map((k) => dateOnlyUTC(k));
    const conflicts = await findHolidayConflicts(holiday.workerId, dates);
    res.json({ conflicts });
  }
);

/**
 * POST /api/admin/holidays/:id/approve — approve a request. Body: { force?: boolean }.
 *
 * Safety gate: if the worker has active shifts (SCHEDULED / CONFIRMED) inside the
 * range and `force` isn't set, responds 409 with the conflicts (the UI warns).
 * With `force` (or no conflicts): sets APPROVED, VACATES each conflicting shift by
 * emitting shift.cancelled (so the team sees the re-opened slot in the Alert
 * Center + can rebook), writes a HOLIDAY block on every day (locking the worker
 * out), and texts the worker on their preferred channel.
 */
adminRouter.post(
  "/holidays/:id/approve",
  async (req: Request, res: Response): Promise<void> => {
    const force = req.body?.force === true;
    const holiday = await prisma.holidayRequest.findUnique({
      where: { id: req.params.id },
      include: {
        worker: { select: { id: true, name: true, phone: true, preferredChannel: true } },
      },
    });
    if (!holiday) {
      res.status(404).json({ error: "Holiday request not found" });
      return;
    }

    const keys = holidayDayKeys(holiday.startDate, holiday.endDate);
    const dates = keys.map((k) => dateOnlyUTC(k));
    const conflicts = await findHolidayConflicts(holiday.workerId, dates);

    // Gate: never silently wipe an active shift — the admin must confirm.
    if (conflicts.length > 0 && !force) {
      res.status(409).json({
        error: "Approving this holiday would vacate active shifts.",
        conflicts,
      });
      return;
    }

    await prisma.holidayRequest.update({
      where: { id: holiday.id },
      data: { status: "APPROVED" },
    });

    // Vacate each conflicting shift: emit shift.cancelled so the team sees the
    // re-opened slot (Alert Center + Suggested Replacements), then the HOLIDAY
    // block written below locks the worker out of being re-selected.
    const now = new Date().toISOString();
    for (const c of conflicts) {
      emitRotaEvent({
        type: "shift.cancelled",
        payload: {
          workerId: holiday.workerId,
          workerName: holiday.worker.name,
          phone: holiday.worker.phone,
          clientName: c.clientName,
          date: c.date,
          dateLabel: c.dateLabel,
          startTime: c.startTime,
          at: now,
          reason: "holiday_approved",
        },
      });
    }

    // Rota lockout: mark each calendar day as HOLIDAY on the board.
    for (const key of keys) {
      const date = dateOnlyUTC(key);
      await prisma.rotaCell.upsert({
        where: { workerId_date: { workerId: holiday.workerId, date } },
        create: { workerId: holiday.workerId, date, status: "HOLIDAY", confirmed: false },
        update: { status: "HOLIDAY", confirmed: false, startTime: null, endTime: null },
      });
    }

    emitRotaEvent({
      type: "holiday.updated",
      payload: { holidayId: holiday.id, workerId: holiday.workerId, status: "APPROVED" },
    });
    emitRotaEvent({ type: "board.updated", payload: { workerId: holiday.workerId } });

    await notifyHolidayDecision(holiday.worker, holiday.startDate, holiday.endDate, true);

    res.json({ ok: true, status: "APPROVED", vacated: conflicts.length });
  }
);

/**
 * POST /api/admin/holidays/:id/reject — reject a request. Sets REJECTED, frees the
 * calendar (removes any HOLIDAY cells previously created for the range), and texts
 * the worker.
 */
adminRouter.post(
  "/holidays/:id/reject",
  async (req: Request, res: Response): Promise<void> => {
    const holiday = await prisma.holidayRequest.findUnique({
      where: { id: req.params.id },
      include: {
        worker: { select: { id: true, name: true, phone: true, preferredChannel: true } },
      },
    });
    if (!holiday) {
      res.status(404).json({ error: "Holiday request not found" });
      return;
    }

    await prisma.holidayRequest.update({
      where: { id: holiday.id },
      data: { status: "REJECTED" },
    });

    // Free the calendar: clear any HOLIDAY blocks we created for this range.
    const dates = holidayDayKeys(holiday.startDate, holiday.endDate).map((k) => dateOnlyUTC(k));
    await prisma.rotaCell.deleteMany({
      where: { workerId: holiday.workerId, date: { in: dates }, status: "HOLIDAY" },
    });

    emitRotaEvent({
      type: "holiday.updated",
      payload: { holidayId: holiday.id, workerId: holiday.workerId, status: "REJECTED" },
    });
    emitRotaEvent({ type: "board.updated", payload: { workerId: holiday.workerId } });

    await notifyHolidayDecision(holiday.worker, holiday.startDate, holiday.endDate, false);

    res.json({ ok: true, status: "REJECTED" });
  }
);

// ----------------------------------------------------------------------------
// Shift templates (per client)
// ----------------------------------------------------------------------------

/** GET /api/admin/clients/:clientId/templates */
adminRouter.get(
  "/clients/:clientId/templates",
  async (req: Request, res: Response): Promise<void> => {
    const templates = await prisma.shiftTemplate.findMany({
      where: { clientId: req.params.clientId },
      orderBy: { startTime: "asc" },
    });
    res.json(templates);
  }
);

/** POST /api/admin/clients/:clientId/templates — Body: { name, startTime, endTime } */
adminRouter.post(
  "/clients/:clientId/templates",
  async (req: Request, res: Response): Promise<void> => {
    const name = String(req.body?.name ?? "").trim();
    const startTime = String(req.body?.startTime ?? "").trim();
    const endTime = String(req.body?.endTime ?? "").trim();
    if (!name || !startTime || !endTime) {
      res.status(400).json({ error: "name, startTime and endTime are required" });
      return;
    }
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const template = await prisma.shiftTemplate.create({
      data: { clientId: req.params.clientId, name, startTime, endTime },
    });
    res.status(201).json(template);
  }
);

/** DELETE /api/admin/templates/:id */
adminRouter.delete(
  "/templates/:id",
  async (req: Request, res: Response): Promise<void> => {
    await prisma.shiftTemplate.deleteMany({ where: { id: req.params.id } });
    res.json({ ok: true });
  }
);

// ----------------------------------------------------------------------------
// Server-Sent Events — live dashboard updates
// ----------------------------------------------------------------------------

/** GET /api/admin/events — SSE stream of real-time rota events. */
adminRouter.get("/events", (req: Request, res: Response): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: ready\ndata: {}\n\n`);

  const onEvent = (event: RotaEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on("rota", onEvent);

  // Heartbeat keeps proxies from closing the idle connection.
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("rota", onEvent);
  });
});
