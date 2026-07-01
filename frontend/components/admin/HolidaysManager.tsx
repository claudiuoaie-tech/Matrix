"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, CalendarDays, User, Plane, AlertTriangle } from "lucide-react";
import { admin } from "@/lib/api";
import type { AdminHolidayRequest, HolidayConflict, HolidayStatus } from "@/lib/types";
import { useRotaEventListener, type Subscribe } from "@/lib/useRotaEvents";

type Filter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

/** YYYY-MM-DD → DD/MM/YYYY. */
function fmt(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
}

/** A holiday date range as one date or "start – end". */
function rangeLabel(start: string, end: string): string {
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

const STATUS_STYLES: Record<HolidayStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-rose-50 text-rose-700",
};

/**
 * Admin Holiday Requests view. Lists requests (pending by default), shows worker
 * name / dates / reason, and offers Approve / Reject quick actions. Refreshes in
 * real time when a worker submits a request or another admin acts on one.
 */
export default function HolidaysManager({ subscribe }: { subscribe: Subscribe }) {
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [rows, setRows] = useState<AdminHolidayRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Conflict warning modal: set when Approve would vacate active shifts.
  const [conflictModal, setConflictModal] = useState<{
    holiday: AdminHolidayRequest;
    conflicts: HolidayConflict[];
  } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    admin
      .adminHolidays(filter === "ALL" ? undefined : filter)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load requests"))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(load, [load]);

  // Real-time: a new request or a decision (from any admin) refreshes the list.
  useRotaEventListener(subscribe, (e) => {
    if (e.type === "holiday.requested" || e.type === "holiday.updated") load();
  });

  // Approve: first check for conflicting active shifts. None → approve straight
  // away; some → open the warning modal so the admin explicitly confirms the vacate.
  async function onApprove(h: AdminHolidayRequest) {
    setBusyId(h.id);
    setError(null);
    try {
      const { conflicts } = await admin.holidayConflicts(h.id);
      if (conflicts.length > 0) {
        setConflictModal({ holiday: h, conflicts });
        return;
      }
      await admin.approveHoliday(h.id, false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve");
    } finally {
      setBusyId(null);
    }
  }

  // Confirmed vacate: force-approve, which flips the conflicting shifts + locks
  // the days as HOLIDAY server-side.
  async function confirmVacate() {
    if (!conflictModal) return;
    const id = conflictModal.holiday.id;
    setBusyId(id);
    setError(null);
    try {
      await admin.approveHoliday(id, true);
      setConflictModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve");
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await admin.rejectHoliday(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reject");
    } finally {
      setBusyId(null);
    }
  }

  const TABS: Filter[] = ["PENDING", "APPROVED", "REJECTED", "ALL"];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plane size={18} className="text-brand" /> Holiday Requests
          </h2>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                  filter === t ? "bg-brand text-white" : "text-muted hover:text-foreground"
                }`}
              >
                {t.toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        )}

        {loading ? (
          <div className="grid place-items-center py-16">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-14 text-center text-sm text-muted">
            <CalendarDays size={28} className="mx-auto mb-2 text-slate-300" />
            No {filter === "ALL" ? "" : filter.toLowerCase()} holiday requests.
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map((h) => (
              <li
                key={h.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <User size={15} className="shrink-0 text-muted" />
                    <span className="truncate font-semibold">
                      {h.workerName ?? "Unknown worker"}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[h.status]}`}
                    >
                      {h.status}
                    </span>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
                    <CalendarDays size={14} className="text-muted" />
                    {rangeLabel(h.startDate, h.endDate)}
                  </p>
                  {h.reason && (
                    <p className="mt-0.5 text-xs italic text-muted">“{h.reason}”</p>
                  )}
                </div>

                {h.status === "PENDING" ? (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => onApprove(h)}
                      disabled={busyId === h.id}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busyId === h.id ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Check size={15} />
                      )}
                      Approve
                    </button>
                    <button
                      onClick={() => onReject(h.id)}
                      disabled={busyId === h.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                    >
                      <X size={15} /> Reject
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {conflictModal && (
        <div
          className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
          onClick={() => busyId === null && setConflictModal(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-700">
                <AlertTriangle size={18} />
              </span>
              <div>
                <h3 className="font-semibold text-foreground">Scheduling conflict</h3>
                <p className="text-sm text-muted">
                  {conflictModal.holiday.workerName ?? "This worker"} has active shifts inside
                  this holiday. Approving will <strong>vacate</strong> them and re-open the slots.
                </p>
              </div>
            </div>

            <ul className="mb-4 max-h-52 space-y-1.5 overflow-y-auto thin-scroll rounded-lg border border-border bg-slate-50/60 p-2 text-sm">
              {conflictModal.conflicts.map((c) => (
                <li key={c.date} className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      c.confirmed
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {c.confirmed ? "Confirmed" : "Pending"}
                  </span>
                  <span className="text-foreground">
                    {c.clientName ?? "Unassigned"}
                    {c.startTime ? ` · ${c.startTime}` : ""} · {c.dateLabel}
                  </span>
                </li>
              ))}
            </ul>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConflictModal(null)}
                disabled={busyId !== null}
                className="rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-muted hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmVacate}
                disabled={busyId !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busyId !== null ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Check size={15} />
                )}
                Approve &amp; vacate shifts
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
