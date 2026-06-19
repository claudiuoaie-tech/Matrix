// Date helpers for the 14-day planning board. We work with calendar dates
// (YYYY-MM-DD) and store them in @db.Date columns as UTC midnight so there's no
// timezone drift between what the admin sees and what is persisted.

const MS_DAY = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date's UTC calendar date as YYYY-MM-DD. */
export function ymdFromUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A UTC-midnight Date for a YYYY-MM-DD key (for @db.Date storage/queries). */
export function dateOnlyUTC(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * The Monday (YYYY-MM-DD) of the week containing `ref` (or today). Computed in
 * the server's local time so "current week" tracks the system date.
 */
export function mondayKey(ref?: string): string {
  const base = ref ? new Date(`${ref}T00:00:00`) : new Date();
  base.setHours(0, 0, 0, 0);
  const dow = (base.getDay() + 6) % 7; // 0 = Monday
  base.setDate(base.getDate() - dow);
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
}

/** The N consecutive date keys starting at `startKey` (default 14). */
export function windowKeys(startKey: string, n = 14): string[] {
  const start = dateOnlyUTC(startKey).getTime();
  return Array.from({ length: n }, (_, i) => ymdFromUTC(new Date(start + i * MS_DAY)));
}

/** Split a stored full name into first / last parts for the board columns. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}
