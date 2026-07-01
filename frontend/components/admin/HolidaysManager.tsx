"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, CalendarDays, User, Plane } from "lucide-react";
import { admin } from "@/lib/api";
import type { AdminHolidayRequest, HolidayStatus } from "@/lib/types";
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

  async function decide(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      if (action === "approve") await admin.approveHoliday(id);
      else await admin.rejectHoliday(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
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
                      onClick={() => decide(h.id, "approve")}
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
                      onClick={() => decide(h.id, "reject")}
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
    </div>
  );
}
