// Presentation helpers shared across the worker and admin UIs.

import type { AllocationState, ShiftSlot } from "./types";

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const SLOTS: ShiftSlot[] = ["AM", "PM", "NIGHT"];

export const SLOT_LABELS: Record<ShiftSlot, string> = {
  AM: "Morning",
  PM: "Afternoon",
  NIGHT: "Night",
};

export const POOL_LABELS: Record<string, string> = {
  POOL_A: "Client A",
  POOL_B: "Client B",
  POOL_C: "Client C",
};

/** Tailwind classes for an allocation-state badge. */
export function stateBadgeClass(state: AllocationState): string {
  switch (state) {
    case "CONFIRMED":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "PROPOSED":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "DECLINED":
      return "bg-rose-100 text-rose-700 border-rose-200";
    case "TIMEOUT":
      return "bg-slate-100 text-slate-500 border-slate-200";
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** YYYY-MM-DD for the Monday of the week containing `ref`. */
export function isoWeekStart(ref = new Date()): string {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}
