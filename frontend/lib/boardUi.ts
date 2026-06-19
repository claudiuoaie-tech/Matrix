// Presentation helpers for the planning board: status colours (matching the
// spec screenshot) plus date/day formatting for the 14-day header.

import type { RotaStatus } from "./types";

export interface StatusStyle {
  label: string;
  // Inline styles so the exact spec colours render regardless of Tailwind purging.
  bg: string;
  fg: string;
}

export const STATUS_STYLES: Record<RotaStatus, StatusStyle> = {
  AVAILABLE: { label: "AVAILABLE", bg: "#9dc3e6", fg: "#0f172a" }, // light blue
  UNAVAILABLE: { label: "UNAVAILABLE", bg: "#fbd6b4", fg: "#7c2d12" }, // soft peach
  SICK: { label: "SICK", bg: "#f3b0d3", fg: "#7a1d4f" }, // soft pink
  REST: { label: "REST", bg: "#7030a0", fg: "#ffffff" }, // deep purple
  HOLIDAY: { label: "HOLIDAY", bg: "#bfbfbf", fg: "#1f2937" }, // medium grey
  CANCELLED: { label: "CANCELLED", bg: "#c55a11", fg: "#ffffff" }, // rust
  NO_SHOW: { label: "NO SHOW", bg: "#ff0000", fg: "#ffffff" }, // solid red
  SCHEDULED: { label: "SCHEDULED", bg: "#a9d08e", fg: "#1a2e05" }, // grass green
  REJECTED: { label: "REJECTED", bg: "#f4a9a0", fg: "#7a1f12" }, // soft red (worker declined)
};

/** Statuses a worker may set themselves (self-service portal). */
export const WORKER_STATUSES: RotaStatus[] = [
  "AVAILABLE",
  "UNAVAILABLE",
  "SICK",
  "REST",
  "HOLIDAY",
];

/**
 * Every status the admin can apply directly from the cell editor. The backend
 * texts the worker for any of these except AVAILABLE / UNAVAILABLE (and NO_SHOW
 * gets a specialised warning). SCHEDULED is handled via the time/template entry.
 */
export const ADMIN_STATUSES: RotaStatus[] = [
  "AVAILABLE",
  "UNAVAILABLE",
  "SICK",
  "REST",
  "HOLIDAY",
  "NO_SHOW",
  "CANCELLED",
  "REJECTED",
];

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "15-Jun" from a YYYY-MM-DD key (parsed as UTC to avoid tz drift). */
export function dateLabel(key: string): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return `${d.getUTCDate()}-${SHORT_MONTHS[d.getUTCMonth()]}`;
}

/** "Mon" from a YYYY-MM-DD key. */
export function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return SHORT_DAYS[d.getUTCDay()];
}

/** True for Saturday/Sunday keys (for subtle weekend shading). */
export function isWeekend(key: string): boolean {
  const dow = new Date(`${key}T00:00:00.000Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Full label like "Mon 15-Jun" used in dialogs. */
export function longDayLabel(key: string): string {
  return `${dayLabel(key)} ${dateLabel(key)}`;
}

/**
 * What a cell displays. For SCHEDULED: the shift name and/or start time
 * ("Early 06:00", "Early", or "06:00"); otherwise the status label.
 */
export function cellText(
  status: RotaStatus,
  startTime: string | null,
  label?: string | null
): string {
  if (status === "SCHEDULED") {
    const parts = [label, startTime].filter(Boolean);
    return parts.length ? parts.join(" ") : "—";
  }
  return STATUS_STYLES[status].label;
}
