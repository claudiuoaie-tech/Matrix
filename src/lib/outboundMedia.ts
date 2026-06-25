/**
 * Outbound media store. Twilio requires outbound media to be a publicly
 * reachable URL, so we decode an admin's uploaded/pasted file to disk and expose
 * it at a public, unauthenticated URL (served by the /api/public router) that
 * Twilio's servers can fetch. Files live under uploads/outbound. On Render the
 * disk is ephemeral, which is fine: Twilio fetches the URL within seconds of
 * sending; we also log the URL in the messages table for tracking.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const OUTBOUND_DIR = path.join(process.cwd(), "uploads", "outbound");

// Allowed attachment types -> file extension. Images + PDF (Twilio MMS/WhatsApp).
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

// Twilio MMS media must stay under ~5 MB.
const MAX_BYTES = 5 * 1024 * 1024;

export interface SavedMedia {
  fileName: string;
  publicUrl: string;
}

/** Absolute public base URL Twilio (and the browser) use to reach this server. */
function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
}

/**
 * Decode a base64 data URL, persist it, and return its public filename + URL.
 * Returns null for an unsupported type, oversized payload, or malformed input.
 */
export function saveOutboundMedia(dataUrl: string): SavedMedia | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const ext = MIME_TO_EXT[match[1].toLowerCase()];
  if (!ext) return null;

  const buf = Buffer.from(match[2], "base64");
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;

  fs.mkdirSync(OUTBOUND_DIR, { recursive: true });
  const fileName = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(OUTBOUND_DIR, fileName), buf);

  return { fileName, publicUrl: `${publicBase()}/api/public/media/${fileName}` };
}

/** True only for our generated filenames (guards the public route against traversal). */
export function isValidMediaName(name: string): boolean {
  return /^[a-f0-9-]+\.(jpg|jpeg|png|gif|webp|pdf)$/i.test(name);
}

/** Absolute path of a stored outbound media file (basename-guarded). */
export function outboundMediaPath(name: string): string {
  return path.join(OUTBOUND_DIR, path.basename(name));
}

/** Content-Type for a stored file, inferred from its extension. */
export function mediaContentType(name: string): string {
  return EXT_TO_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}
