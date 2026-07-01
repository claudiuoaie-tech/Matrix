"use client";

import { AlertTriangle, X, Clock, Building2, User } from "lucide-react";
import type { CancellationAlert } from "@/lib/types";

/**
 * Anti-no-show Alert Center — a fixed, high-visibility stack of cards for late
 * cancellations (a worker dropping an already-CONFIRMED shift). Each card carries
 * a blinking red "⚠️ LATE CANCELLATION" tag so a coordinator can react instantly.
 * Cards persist until dismissed. Rendered fixed to the viewport, so it floats over
 * whatever tab the operator is on.
 */
export default function AlertCenter({
  alerts,
  onDismiss,
  onClear,
}: {
  alerts: CancellationAlert[];
  onDismiss: (key: string) => void;
  onClear: () => void;
}) {
  if (alerts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div className="pointer-events-auto flex items-center justify-between rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
        <span className="inline-flex items-center gap-1.5">
          <AlertTriangle size={14} /> Alert Center · {alerts.length}
        </span>
        <button onClick={onClear} className="rounded px-2 py-0.5 hover:bg-white/20">
          Clear all
        </button>
      </div>

      <div className="thin-scroll flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
        {alerts.map((a) => {
          const key = `${a.workerId}-${a.date}-${a.at}`;
          return (
            <div
              key={key}
              className="pointer-events-auto rounded-xl border-2 border-rose-300 bg-white p-3 shadow-xl"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex animate-pulse items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                  <AlertTriangle size={11} /> ⚠️ Late Cancellation
                </span>
                <button
                  onClick={() => onDismiss(key)}
                  title="Dismiss"
                  className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <User size={14} className="text-rose-500" /> {a.workerName}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <Building2 size={13} /> {a.clientName ?? "Unassigned client"}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <Clock size={13} /> {a.dateLabel}
                {a.startTime ? ` · ${a.startTime}` : ""}
              </p>
              <p className="mt-2 text-[11px] font-medium text-rose-600">
                Slot re-opened — find a replacement.
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
