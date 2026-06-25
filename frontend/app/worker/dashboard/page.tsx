"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  ClipboardList,
  Plane,
  LogOut,
  Check,
  X,
  Loader2,
  Sun,
  Sunset,
  Moon,
  Plus,
  Lock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { auth, worker as workerApi, ApiError } from "@/lib/api";
import { clearSession, getCachedWorker, getToken } from "@/lib/session";
import { DAY_LABELS, SLOTS, SLOT_LABELS, formatDate } from "@/lib/ui";
import {
  STATUS_STYLES,
  WORKER_STATUSES,
  dateLabel,
  dayLabel,
  cellText,
} from "@/lib/boardUi";
import type {
  AvailabilityCell,
  HolidayRequest,
  RotaStatus,
  ScheduleEntry,
  ShiftSlot,
  WorkerBoardResponse,
  WorkerProfile,
  WorkerShift,
} from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";

type Tab = "status" | "availability" | "schedule" | "holidays";

const SLOT_ICON: Record<ShiftSlot, React.ReactNode> = {
  AM: <Sun size={14} />,
  PM: <Sunset size={14} />,
  NIGHT: <Moon size={14} />,
};

export default function WorkerDashboard() {
  const router = useRouter();
  // Default landing tab after OTP login is the Schedule view.
  const [tab, setTab] = useState<Tab>("schedule");
  const [me, setMe] = useState<Partial<WorkerProfile> | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/worker/login");
      return;
    }
    setMe(getCachedWorker());
    workerApi
      .me()
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          clearSession();
          router.replace("/worker/login");
        }
      })
      .finally(() => setReady(true));
  }, [router]);

  async function logout() {
    try {
      await auth.logout();
    } catch {
      /* ignore */
    }
    clearSession();
    router.replace("/worker/login");
  }

  if (!ready) {
    return (
      <main className="flex-1 grid place-items-center">
        <Loader2 className="animate-spin text-muted" />
      </main>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "status", label: "My Rota", icon: <CalendarRange size={18} /> },
    { key: "availability", label: "Weekly", icon: <CalendarDays size={18} /> },
    { key: "schedule", label: "Schedule", icon: <ClipboardList size={18} /> },
    { key: "holidays", label: "Holidays", icon: <Plane size={18} /> },
  ];

  return (
    <main className="flex-1 w-full max-w-lg mx-auto px-4 pb-28 pt-5">
      <header className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm text-muted">Welcome back</p>
          <h1 className="text-xl font-bold">{me?.name ?? "Worker"}</h1>
        </div>
        <button
          onClick={logout}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted hover:text-foreground"
        >
          <LogOut size={16} /> Sign out
        </button>
      </header>

      {tab === "status" && <MyRotaTab />}
      {tab === "availability" && <AvailabilityTab />}
      {tab === "schedule" && <ScheduleTab />}
      {tab === "holidays" && <HolidaysTab />}

      {/* Mobile-first bottom tab bar */}
      <nav className="fixed bottom-0 inset-x-0 border-t border-border bg-card/95 backdrop-blur">
        <div className="max-w-lg mx-auto grid grid-cols-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex flex-col items-center gap-1 py-3 text-xs font-medium transition ${
                tab === t.key ? "text-brand" : "text-muted"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </main>
  );
}

// ---------------------------------------------------------------------------
// My Rota — 14-day self-service status
// ---------------------------------------------------------------------------

// Worker availability planning window: up to 8 weeks ahead (Phase 3).
const ROTA_FORWARD_WEEKS = 8;

/** Today's local calendar date as YYYY-MM-DD. */
function rotaTodayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** The Monday (YYYY-MM-DD) of the week containing the given key. */
function rotaMondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function MyRotaTab() {
  const [board, setBoard] = useState<WorkerBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Week navigation — page the 2-week window from the current week up to 8
  // weeks ahead. Initialised client-side (no SSR date mismatch in this tab).
  const [weekStart, setWeekStart] = useState<string>(() => rotaMondayOf(rotaTodayKey()));
  const currentMonday = rotaMondayOf(rotaTodayKey());
  const maxWeekStart = addDaysStr(currentMonday, ROTA_FORWARD_WEEKS * 7);
  const canPrev = weekStart > currentMonday;
  const canNext = weekStart < maxWeekStart;

  function shiftWeek(weeks: number) {
    setWeekStart((cur) => {
      const next = addDaysStr(cur, weeks * 7);
      if (next < currentMonday) return currentMonday;
      if (next > maxWeekStart) return maxWeekStart;
      return next;
    });
  }

  const load = useCallback(() => {
    setLoading(true);
    workerApi
      .board(weekStart)
      .then(setBoard)
      .finally(() => setLoading(false));
  }, [weekStart]);

  useEffect(load, [load]);

  async function set(date: string, status: RotaStatus) {
    setSaving(date);
    try {
      await workerApi.setBoardCell(date, status);
      setBoard((prev) =>
        prev
          ? { ...prev, cells: { ...prev.cells, [date]: { status, startTime: null, label: null } } }
          : prev
      );
    } finally {
      setSaving(null);
    }
  }

  if (loading || !board) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <section>
      <h2 className="font-semibold mb-1">My rota</h2>
      <p className="text-sm text-muted mb-3">
        Set your availability up to {ROTA_FORWARD_WEEKS} weeks ahead. Scheduled shifts are set
        by the office.
      </p>

      {/* Week navigation */}
      <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2">
        <button
          onClick={() => shiftWeek(-1)}
          disabled={!canPrev}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted transition hover:text-foreground disabled:opacity-40"
        >
          <ChevronLeft size={16} /> Prev
        </button>
        <span className="text-sm font-semibold">
          {board.days.length
            ? `${dateLabel(board.days[0])} – ${dateLabel(board.days[board.days.length - 1])}`
            : ""}
        </span>
        <button
          onClick={() => shiftWeek(1)}
          disabled={!canNext}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted transition hover:text-foreground disabled:opacity-40"
        >
          Next <ChevronRight size={16} />
        </button>
      </div>

      <div className="space-y-2">
        {board.days.map((d) => {
          const cell = board.cells[d];
          const adminSet =
            cell &&
            (cell.status === "SCHEDULED" ||
              cell.status === "CANCELLED" ||
              cell.status === "NO_SHOW");
          return (
            <div key={d} className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">
                  {dayLabel(d)} {dateLabel(d)}
                </span>
                {cell && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{
                      background: STATUS_STYLES[cell.status].bg,
                      color: STATUS_STYLES[cell.status].fg,
                    }}
                  >
                    {adminSet && <Lock size={11} />}
                    {cellText(cell.status, cell.startTime, cell.label)}
                  </span>
                )}
              </div>
              {adminSet ? (
                <p className="text-xs text-muted">
                  This day is managed by the office and can&apos;t be changed here.
                </p>
              ) : (
                <div className="grid grid-cols-5 gap-1">
                  {WORKER_STATUSES.map((s) => {
                    const active = cell?.status === s;
                    return (
                      <button
                        key={s}
                        onClick={() => set(d, s)}
                        disabled={saving === d}
                        className="rounded-md px-1 py-1.5 text-[10px] font-semibold leading-tight transition disabled:opacity-50"
                        style={
                          active
                            ? { background: STATUS_STYLES[s].bg, color: STATUS_STYLES[s].fg }
                            : { background: "#f1f5f9", color: "#64748b" }
                        }
                      >
                        {STATUS_STYLES[s].label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Availability matrix
// ---------------------------------------------------------------------------

function cellKey(day: number, slot: ShiftSlot) {
  return `${day}-${slot}`;
}

function AvailabilityTab() {
  const [available, setAvailable] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    workerApi
      .getAvailability()
      .then((cells: AvailabilityCell[]) => {
        const next = new Set<string>();
        cells.forEach((c) => {
          if (c.available) next.add(cellKey(c.dayOfWeek, c.slot));
        });
        setAvailable(next);
      })
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (set: Set<string>) => {
    setSaving(true);
    const payload: AvailabilityCell[] = [];
    for (let day = 0; day < 7; day++) {
      for (const slot of SLOTS) {
        payload.push({ dayOfWeek: day, slot, available: set.has(cellKey(day, slot)) });
      }
    }
    try {
      await workerApi.saveAvailability(payload);
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }, []);

  function toggle(day: number, slot: ShiftSlot) {
    setAvailable((prev) => {
      const next = new Set(prev);
      const k = cellKey(day, slot);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      void save(next);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">Weekly availability</h2>
          <p className="text-sm text-muted">Tap a slot to mark yourself available.</p>
        </div>
        <span className="text-xs text-muted h-4">
          {saving ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Saving…
            </span>
          ) : savedAt ? (
            `Saved ${savedAt}`
          ) : (
            ""
          )}
        </span>
      </div>

      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="space-y-2">
          {DAY_LABELS.map((label, day) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-10 text-sm font-medium text-muted">{label}</span>
              <div className="grid grid-cols-3 gap-2 flex-1">
                {SLOTS.map((slot) => {
                  const on = available.has(cellKey(day, slot));
                  return (
                    <button
                      key={slot}
                      onClick={() => toggle(day, slot)}
                      className={`flex items-center justify-center gap-1 rounded-lg border py-2 text-xs font-medium transition ${
                        on
                          ? "border-brand bg-indigo-50 text-brand"
                          : "border-border bg-white text-muted hover:border-slate-300"
                      }`}
                    >
                      {SLOT_ICON[slot]}
                      {SLOT_LABELS[slot]}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduleTab() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [shifts, setShifts] = useState<WorkerShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([workerApi.schedule(), workerApi.shifts()])
      .then(([sch, shf]) => {
        setEntries(sch);
        setShifts(shf);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function respond(id: string, action: "accept" | "decline") {
    setActing(id);
    try {
      await workerApi.respond(id, action);
      load();
    } finally {
      setActing(null);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-16">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  // Pending offers awaiting a response (shown with Accept / Decline).
  const offers = entries.filter((e) => e.state === "PROPOSED");
  // Confirmed shifts come from the planning board (covers admin-set + accepted).
  const confirmed = shifts;
  const empty = offers.length === 0 && confirmed.length === 0;

  const sched = STATUS_STYLES.SCHEDULED;

  return (
    <section className="space-y-6">
      <h2 className="font-semibold">My schedule</h2>

      {empty && (
        <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted">
          No upcoming shifts yet. We&apos;ll text you when one comes up.
        </div>
      )}

      {/* Pending shift offers */}
      {offers.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-muted">
            Shift offers — please respond
          </h3>
          <div className="space-y-3">
            {offers.map((e) => (
              <div key={e.allocationId} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{e.shift.client}</p>
                    <p className="text-sm text-muted">
                      {formatDate(e.shift.date)} · {SLOT_LABELS[e.shift.slot]} ·{" "}
                      {e.shift.startTime}–{e.shift.endTime}
                    </p>
                  </div>
                  <StatusBadge state={e.state} />
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => respond(e.allocationId, "accept")}
                    disabled={acting === e.allocationId}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {acting === e.allocationId ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Check size={16} />
                    )}
                    Accept
                  </button>
                  <button
                    onClick={() => respond(e.allocationId, "decline")}
                    disabled={acting === e.allocationId}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-rose-600 disabled:opacity-50"
                  >
                    <X size={16} /> Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmed shifts (from the live rota board) */}
      {confirmed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-muted">Confirmed shifts</h3>
          <div className="space-y-3">
            {confirmed.map((s) => (
              <div
                key={s.id}
                className="overflow-hidden rounded-2xl border border-border bg-card"
                style={{ borderLeft: `4px solid ${sched.bg}` }}
              >
                <div className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium">{s.client ?? "Shift"}</p>
                    <p className="text-sm text-muted">
                      {formatDate(s.date)}
                      {s.startTime ? ` · ${s.startTime}${s.endTime ? `–${s.endTime}` : ""}` : ""}
                    </p>
                    {s.label && (
                      <p className="mt-0.5 text-xs text-muted">Section: {s.label}</p>
                    )}
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{ background: sched.bg, color: sched.fg }}
                  >
                    {s.startTime ?? sched.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

/** Add `n` days to a YYYY-MM-DD key (UTC), returning a YYYY-MM-DD key. */
function addDaysStr(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function HolidaysTab() {
  const [holidays, setHolidays] = useState<HolidayRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on the client to avoid an SSR/client date mismatch.
  const [today, setToday] = useState("");

  const MAX_DAYS = 90;
  const MAX_NOTE = 280;

  useEffect(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    setToday(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    workerApi
      .holidays()
      .then(setHolidays)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // Inclusive day count for the selected range (0 when incomplete).
  const days =
    start && end && end >= start
      ? Math.round(
          (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000
        ) + 1
      : 0;

  // Earliest permitted start date: 7 full days of notice from today.
  const minStart = today ? addDaysStr(today, 7) : "";

  // Live, field-level validation problems (empty array = OK to submit).
  const problems: string[] = [];
  if (start && minStart && start < minStart)
    problems.push("Any holiday request must be made at least 7 days in advance");
  if (start && end && end < start) problems.push("End date must be on or after the start date.");
  if (days > MAX_DAYS) problems.push(`A request can't exceed ${MAX_DAYS} days.`);
  if (note.length > MAX_NOTE) problems.push(`Reason must be ${MAX_NOTE} characters or fewer.`);
  if (
    start &&
    end &&
    holidays.some(
      (h) =>
        h.status !== "REJECTED" &&
        start <= h.endDate.slice(0, 10) &&
        end >= h.startDate.slice(0, 10)
    )
  ) {
    problems.push("These dates overlap an existing request.");
  }
  const canSubmit = !!start && !!end && problems.length === 0 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      await workerApi.requestHoliday(start, end, note || undefined);
      setStart("");
      setEnd("");
      setNote("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="font-semibold mb-1">Request time off</h2>
        <p className="text-sm text-muted mb-3">
          We&apos;ll exclude you from shift offers during these dates.
        </p>
        <form onSubmit={submit} className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">From</label>
              <input
                type="date"
                required
                value={start}
                min={minStart || undefined}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">To</label>
              <input
                type="date"
                required
                value={end}
                min={start || minStart || undefined}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          {days > 0 && problems.length === 0 && (
            <p className="text-xs text-muted">
              {days} day{days === 1 ? "" : "s"} off requested.
            </p>
          )}

          <div>
            <input
              type="text"
              value={note}
              maxLength={MAX_NOTE}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <p className="mt-1 text-right text-[11px] text-muted">
              {note.length}/{MAX_NOTE}
            </p>
          </div>

          {/* Inline validation problems */}
          {problems.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              {problems.map((p) => (
                <li key={p} className="flex items-start gap-1.5 text-xs text-rose-700">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  {p}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Submit request
          </button>
        </form>
      </div>

      <div>
        <h3 className="font-semibold mb-2">Your requests</h3>
        {loading ? (
          <div className="grid place-items-center py-8">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : holidays.length === 0 ? (
          <p className="text-sm text-muted">No holiday requests yet.</p>
        ) : (
          <div className="space-y-2">
            {holidays.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {formatDate(h.startDate)} → {formatDate(h.endDate)}
                  </p>
                  {h.note && <p className="text-xs text-muted">{h.note}</p>}
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                    h.status === "APPROVED"
                      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                      : h.status === "REJECTED"
                      ? "bg-rose-100 text-rose-700 border-rose-200"
                      : "bg-amber-100 text-amber-700 border-amber-200"
                  }`}
                >
                  {h.status.charAt(0) + h.status.slice(1).toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
