// Local session cache for the worker portal. The opaque session token issued by
// the backend is kept in localStorage so the worker stays logged in on-device.

import type { WorkerProfile } from "./types";

const TOKEN_KEY = "rm_token";
const WORKER_KEY = "rm_worker";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, worker: Partial<WorkerProfile>): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(WORKER_KEY, JSON.stringify(worker));
}

export function getCachedWorker(): Partial<WorkerProfile> | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(WORKER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<WorkerProfile>;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(WORKER_KEY);
}
