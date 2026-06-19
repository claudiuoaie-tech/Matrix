"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Pencil,
  Ban,
  UserX,
  UserCheck,
  X,
  AlertTriangle,
  UploadCloud,
  Trash2,
  ExternalLink,
  FileText,
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
} from "lucide-react";
import { admin } from "@/lib/api";
import type {
  AdminWorker,
  ClientPool,
  DocType,
  ImportSummary,
  WorkerDocument,
  WorkerStatus,
} from "@/lib/types";
import { POOL_LABELS } from "@/lib/ui";

const POOLS: ClientPool[] = ["POOL_A", "POOL_B", "POOL_C"];

// Canonical CSV header + a single example row to guide admins.
const CSV_HEADERS = ["FirstName", "LastName", "PhoneNumber", "Email", "RTWExpiryDate", "Skills"];
const CSV_TEMPLATE =
  CSV_HEADERS.join(",") +
  "\r\n" +
  ["Jane", "Doe", "+15550001234", "jane.doe@example.com", "2026-12-31", '"Forklift, Driver"'].join(",") +
  "\r\n";

/** Trigger a browser download of `content` as `filename`. */
function downloadFile(content: string, filename: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Local timestamp like 20260619-1432 for the export filename. */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const DOC_TYPES: DocType[] = ["PASSPORT", "RTW", "PROOF_OF_ADDRESS", "OTHER"];
const DOC_LABELS: Record<DocType, string> = {
  PASSPORT: "Passport",
  RTW: "Right to Work",
  PROOF_OF_ADDRESS: "Proof of Address",
  OTHER: "Other",
};
const ACCEPT = "image/jpeg,image/png,application/pdf";

/** Expiry state for an ISO RTW date. `now` is null until mounted (avoids SSR drift). */
function rtwInfo(iso: string | null | undefined, now: number | null) {
  if (!iso) return { date: null as string | null, expired: false };
  const d = new Date(iso);
  const date = d.toISOString().slice(0, 10);
  if (now === null) return { date, expired: false };
  const ref = new Date(now);
  const expMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const todayMid = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  return { date, expired: expMid < todayMid };
}

function statusClass(status: WorkerStatus): string {
  switch (status) {
    case "ACTIVE":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "SUSPENDED":
      return "bg-amber-100 text-amber-700 border-amber-200";
    default:
      return "bg-slate-100 text-slate-500 border-slate-200";
  }
}

export default function WorkersManager() {
  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminWorker | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  // CSV import/export state.
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setNow(Date.now()), []);

  const load = useCallback(() => {
    admin
      .workers()
      .then(setWorkers)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function setStatus(w: AdminWorker, status: WorkerStatus) {
    setBusyId(w.id);
    try {
      await admin.updateWorker(w.id, { status });
      load();
    } finally {
      setBusyId(null);
    }
  }

  function downloadTemplate() {
    downloadFile(CSV_TEMPLATE, "workers_template.csv");
  }

  async function exportCsv() {
    setCsvError(null);
    setExporting(true);
    try {
      const csv = await admin.exportWorkers();
      downloadFile(csv, `workers_export_${fileStamp()}.csv`);
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function onCsvPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setCsvError(null);
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      setCsvError("Please choose a .csv file.");
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      const result = await admin.importWorkers(text);
      setSummary(result);
      load();
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-20">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h3 className="font-semibold">Workers ({workers.length})</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={downloadTemplate}
            title="Download a blank CSV template with the required columns"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-muted hover:text-foreground"
          >
            <FileSpreadsheet size={16} /> Template
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            title="Import workers from a .csv file"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
          >
            {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            Import CSV
          </button>
          <button
            onClick={exportCsv}
            disabled={exporting}
            title="Export active workers to a .csv file"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
          >
            {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            Export CSV
          </button>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white"
          >
            <Plus size={16} /> Add worker
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={onCsvPicked}
          />
        </div>
      </header>

      {csvError && (
        <p className="border-b border-rose-100 bg-rose-50 px-5 py-2 text-sm text-rose-700">
          {csvError}
        </p>
      )}

      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-5 py-2 font-medium">Phone</th>
              <th className="px-5 py-2 font-medium">Pool</th>
              <th className="px-5 py-2 font-medium">Skills</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium">RTW Expiry</th>
              <th className="px-5 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id} className="border-t border-border">
                <td className="px-5 py-2.5 font-medium">{w.name}</td>
                <td className="px-5 py-2.5 font-mono text-xs text-muted">{w.phone}</td>
                <td className="px-5 py-2.5">{POOL_LABELS[w.clientPool]}</td>
                <td className="px-5 py-2.5">
                  <SkillTags skills={w.skills ?? []} />
                </td>
                <td className="px-5 py-2.5">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(
                      w.status
                    )}`}
                  >
                    {w.status.charAt(0) + w.status.slice(1).toLowerCase()}
                  </span>
                </td>
                <td className="px-5 py-2.5">
                  {(() => {
                    const info = rtwInfo(w.rtwExpiryDate, now);
                    if (!info.date) return <span className="text-xs text-slate-300">—</span>;
                    return info.expired ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-700">
                        <AlertTriangle size={12} /> EXPIRED · {info.date}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">{info.date}</span>
                    );
                  })()}
                </td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {busyId === w.id && <Loader2 size={14} className="animate-spin text-muted" />}
                    <button
                      onClick={() => setEditing(w)}
                      title="Edit"
                      className="rounded-md border border-border p-1.5 text-muted hover:text-foreground"
                    >
                      <Pencil size={14} />
                    </button>
                    {w.status === "ACTIVE" ? (
                      <button
                        onClick={() => setStatus(w, "SUSPENDED")}
                        title="Suspend"
                        className="rounded-md border border-amber-200 p-1.5 text-amber-600 hover:bg-amber-50"
                      >
                        <Ban size={14} />
                      </button>
                    ) : (
                      <button
                        onClick={() => setStatus(w, "ACTIVE")}
                        title="Reactivate"
                        className="rounded-md border border-emerald-200 p-1.5 text-emerald-600 hover:bg-emerald-50"
                      >
                        <UserCheck size={14} />
                      </button>
                    )}
                    {w.status !== "INACTIVE" && (
                      <button
                        onClick={() => setStatus(w, "INACTIVE")}
                        title="Set inactive"
                        className="rounded-md border border-border p-1.5 text-slate-500 hover:bg-slate-50"
                      >
                        <UserX size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <WorkerModal
          worker={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            load();
          }}
        />
      )}

      {/* Import loading overlay */}
      {importing && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-8 py-6 shadow-xl">
            <Loader2 size={28} className="animate-spin text-brand" />
            <p className="text-sm font-medium">Importing workers…</p>
          </div>
        </div>
      )}

      {/* Import summary modal */}
      {summary && <ImportSummaryModal summary={summary} onClose={() => setSummary(null)} />}
    </div>
  );
}

function ImportSummaryModal({
  summary,
  onClose,
}: {
  summary: ImportSummary;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <div className="thin-scroll max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 size={20} className="text-emerald-600" />
          <h3 className="font-semibold">Import complete</h3>
        </div>
        <p className="mb-4 text-sm text-muted">{summary.message}</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <Stat label="Created" value={summary.created} tone="emerald" />
          <Stat label="Updated" value={summary.updated} tone="indigo" />
          <Stat label="Skipped" value={summary.skipped} tone="slate" />
          <Stat label="Flagged expired" value={summary.expiredFlagged} tone="rose" />
        </div>

        {summary.errors.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Row notes ({summary.errors.length})
            </p>
            <ul className="thin-scroll max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-slate-50/60 p-2">
              {summary.errors.map((e, i) => (
                <li key={i} className="text-xs text-slate-600">
                  <span className="font-medium">Row {e.row}:</span> {e.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "indigo" | "slate" | "rose";
}) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    slate: "bg-slate-50 text-slate-600 border-slate-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="mt-1 text-[11px] font-medium">{label}</p>
    </div>
  );
}

function WorkerModal({
  worker,
  onClose,
  onSaved,
}: {
  worker: AdminWorker | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(worker?.name ?? "");
  const [phone, setPhone] = useState(worker?.phone ?? "");
  const [email, setEmail] = useState(worker?.email ?? "");
  const [pool, setPool] = useState<ClientPool>(worker?.clientPool ?? "POOL_A");
  const [rtw, setRtw] = useState(worker?.rtwExpiryDate ? worker.rtwExpiryDate.slice(0, 10) : "");
  const [skills, setSkills] = useState<string[]>(worker?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (worker) {
        await admin.updateWorker(worker.id, {
          name,
          phone,
          email: email.trim() || null,
          clientPool: pool,
          rtwExpiryDate: rtw || null,
          skills,
        });
      } else {
        await admin.createWorker({
          name,
          phone,
          email: email.trim() || null,
          clientPool: pool,
          rtwExpiryDate: rtw || null,
          skills,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="thin-scroll max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{worker ? "Edit worker" : "Add worker"}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Phone (E.164)</label>
            <input
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15550001234"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Client pool</label>
            <select
              value={pool}
              onChange={(e) => setPool(e.target.value as ClientPool)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            >
              {POOLS.map((p) => (
                <option key={p} value={p}>
                  {POOL_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Right to Work expiry (optional)
            </label>
            <input
              type="date"
              value={rtw}
              onChange={(e) => setRtw(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Skills</label>
            <SkillsInput skills={skills} onChange={setSkills} />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {worker ? "Save changes" : "Create worker"}
          </button>
        </form>

        {worker ? (
          <DocumentsVault workerId={worker.id} />
        ) : (
          <p className="mt-4 border-t border-border pt-4 text-xs text-muted">
            Save the worker first to upload compliance documents.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills — read-only badge list (table) + editable tag input (modal)
// ---------------------------------------------------------------------------

/** Compact, scannable skill badges. Caps the visible count to avoid clutter. */
function SkillTags({ skills, max = 4 }: { skills: string[]; max?: number }) {
  if (!skills || skills.length === 0) {
    return <span className="text-xs text-slate-300">—</span>;
  }
  const shown = skills.slice(0, max);
  const extra = skills.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((s) => (
        <span
          key={s}
          className="inline-flex items-center rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700"
        >
          {s}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500"
          title={skills.slice(max).join(", ")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/**
 * Tag-style multi-skill editor. Type a skill and press Enter (or comma) to add
 * it; click the × on a tag to remove it; Backspace on an empty field removes the
 * last tag. Pasting a comma-separated list adds them all.
 */
function SkillsInput({
  skills,
  onChange,
}: {
  skills: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function addTokens(text: string) {
    const parts = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...skills];
    for (const p of parts) {
      const clean = p.slice(0, 40);
      if (!next.some((x) => x.toLowerCase() === clean.toLowerCase())) next.push(clean);
    }
    onChange(next.slice(0, 30));
  }

  function commitDraft() {
    if (draft.trim()) {
      addTokens(draft);
      setDraft("");
    }
  }

  function remove(skill: string) {
    onChange(skills.filter((s) => s !== skill));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1.5 focus-within:border-brand">
      {skills.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700"
        >
          {s}
          <button
            type="button"
            onClick={() => remove(s)}
            className="text-indigo-400 hover:text-indigo-700"
            aria-label={`Remove ${s}`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitDraft();
          } else if (e.key === "Backspace" && !draft && skills.length) {
            onChange(skills.slice(0, -1));
          }
        }}
        onBlur={commitDraft}
        placeholder={skills.length ? "Add skill…" : "e.g. Forklift, Supervisor, Driver"}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents vault — drag-and-drop upload, categorise, view/download, delete
// ---------------------------------------------------------------------------

function DocumentsVault({ workerId }: { workerId: string }) {
  const [docs, setDocs] = useState<WorkerDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState<DocType>("RTW");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    admin
      .documents(workerId)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [workerId]);

  useEffect(load, [load]);

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read file"));
      r.readAsDataURL(file);
    });
  }

  async function upload(file: File) {
    setError(null);
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
      setError("Only JPEG, PNG and PDF files are allowed.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("File exceeds the 15 MB limit.");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      await admin.uploadDocument(workerId, {
        docType,
        fileName: file.name,
        mimeType: file.type,
        data: dataUrl,
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    await admin.deleteDocument(id);
    load();
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h4 className="mb-2 flex items-center gap-1.5 font-semibold">
        <FileText size={16} /> Documents vault
      </h4>

      {/* Category + drop zone */}
      <div className="mb-2 flex items-center gap-2">
        <label className="text-xs font-medium text-muted">Type:</label>
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as DocType)}
          className="rounded-lg border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
        >
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOC_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragOver ? "border-brand bg-indigo-50/50" : "border-border bg-slate-50/50 hover:bg-slate-50"
        }`}
      >
        {uploading ? (
          <Loader2 size={20} className="animate-spin text-muted" />
        ) : (
          <UploadCloud size={20} className="text-muted" />
        )}
        <span className="text-sm font-medium">
          Drop a file here, or click to browse
        </span>
        <span className="text-[11px] text-muted">JPEG, PNG or PDF · max 15 MB</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="mt-1.5 text-xs text-rose-600">{error}</p>}

      {/* Existing files */}
      <div className="mt-3">
        {loading ? (
          <div className="grid place-items-center py-4">
            <Loader2 size={16} className="animate-spin text-muted" />
          </div>
        ) : docs.length === 0 ? (
          <p className="text-xs text-muted">No documents uploaded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2"
              >
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                  {DOC_LABELS[d.docType]}
                </span>
                <span className="flex-1 truncate text-sm" title={d.fileName}>
                  {d.fileName}
                </span>
                <a
                  href={admin.documentFileUrl(d.id)}
                  target="_blank"
                  rel="noreferrer"
                  title="View / download"
                  className="rounded-md border border-border p-1.5 text-muted hover:text-foreground"
                >
                  <ExternalLink size={14} />
                </a>
                <button
                  onClick={() => remove(d.id)}
                  title="Delete"
                  className="rounded-md border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
