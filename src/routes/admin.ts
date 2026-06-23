import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { ClientPool, RotaStatus, DocType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { sendSms } from "../lib/twilio";
import { bus, emitRotaEvent, RotaEvent } from "../lib/events";
import { revokeSessions } from "../lib/auth";
import { requireAdmin } from "../lib/adminAuth";
import { isRtwExpired } from "../lib/rtw";
import { parseCsv, buildCsv, parseFlexibleDate } from "../lib/csv";
import { fireWebhook } from "../services/webhook.service";
import {
  mondayKey,
  windowKeys,
  dateOnlyUTC,
  ymdFromUTC,
  splitName,
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
 * (AVAILABLE / UNAVAILABLE). NO_SHOW gets a specialised warning.
 */
function overrideSmsBody(
  status: RotaStatus,
  date: Date,
  startTime: string | null,
  shiftLabel: string | null
): string | null {
  if (SILENT_OVERRIDE_STATUSES.includes(status)) return null;
  const dayLabel = dateLabelUTC(date);
  if (status === "NO_SHOW") {
    return `Warning: You have been marked as a No Show for your shift on ${dayLabel}. Repeated absences may result in the termination of your assignment.`;
  }
  let statusLabel: string = status;
  if (status === "SCHEDULED") {
    const parts = [shiftLabel, startTime ? `start ${startTime}` : null].filter(Boolean);
    statusLabel = parts.length ? `SCHEDULED (${parts.join(", ")})` : "SCHEDULED";
  }
  return `Your status for ${dayLabel} has been updated to ${statusLabel}.`;
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
  shiftLabel: string | null = null
): Promise<boolean> {
  const body = overrideSmsBody(status, date, startTime, shiftLabel);
  if (!body) return false;
  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (!worker) return false;
  await sendSms(worker.phone, body);
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

/** GET /api/admin/workers — every worker with allocation/holiday counts. */
adminRouter.get("/workers", async (_req: Request, res: Response): Promise<void> => {
  const workers = await prisma.worker.findMany({
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
  const phone = String(req.body?.phone ?? "").trim().replace(/\s+/g, "");
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

  const worker = await prisma.worker.create({
    data: {
      name,
      phone,
      email,
      clientPool: clientPool as ClientPool,
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
  if (req.body?.phone != null) data.phone = String(req.body.phone).trim().replace(/\s+/g, "");
  if (req.body?.clientPool != null && POOLS.includes(req.body.clientPool)) {
    data.clientPool = req.body.clientPool;
  }
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
      const phone = get(col.phone).replace(/\s+/g, "");
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
    where: { status: "ACTIVE" },
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
    const dateStr = new Date(s.date).toLocaleDateString();
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

  if (!messageBody) {
    res.status(400).json({ error: "messageBody is required" });
    return;
  }
  if (workerIds.length === 0) {
    res.status(400).json({ error: "At least one recipient is required" });
    return;
  }

  const workers = await prisma.worker.findMany({
    where: { id: { in: workerIds }, status: "ACTIVE" },
  });

  // Dispatch SMS to every recipient.
  await Promise.all(workers.map((w) => sendSms(w.phone, messageBody)));

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
  });
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

  const unread = await prisma.incomingMessage.count({ where: { isRead: false } });

  res.json({
    unread,
    messages: messages.map((m) => ({
      id: m.id,
      fromNumber: m.fromNumber,
      messageBody: m.messageBody,
      channel: m.channel,
      receivedAt: m.receivedAt.toISOString(),
      isRead: m.isRead,
      workerName: m.worker?.name ?? null,
    })),
  });
});

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

// ----------------------------------------------------------------------------
// Clients (for the board filter dropdown)
// ----------------------------------------------------------------------------

/** GET /api/admin/clients — clients with their pool, for the board filter. */
adminRouter.get("/clients", async (_req: Request, res: Response): Promise<void> => {
  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { companyName: "asc" },
    select: { id: true, companyName: true, address: true, pool: true },
  });
  res.json(clients);
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
        input.label ?? null
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
          c.label ?? null
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
