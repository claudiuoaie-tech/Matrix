// Minimal, dependency-free CSV helpers for the worker import/export feature.
// Handles quoted fields, embedded commas/newlines, and "" escaping per RFC 4180.

/** Parse CSV text into an array of rows (each row an array of cell strings). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip a UTF-8 BOM if present (Excel adds one).
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore; handled with the following \n (or trailing)
    } else {
      field += c;
    }
  }
  // Flush the final field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Quote a single CSV field when it contains a comma, quote or newline. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV string from a header row and data rows. */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const r of rows) lines.push(r.map(csvField).join(","));
  return lines.join("\r\n");
}

/**
 * Parse a date in DD/MM/YYYY, D/M/YYYY or YYYY-MM-DD form into a UTC-midnight
 * Date, or null if it can't be understood. Returns null for empty input.
 */
export function parseFlexibleDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD (optionally with time — take the date part).
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return toUtc(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // DD/MM/YYYY or DD-MM-YYYY (also accepts D/M/YYYY).
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    return toUtc(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  return null;
}

function toUtc(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow (e.g. 31/02 rolling into March).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}
