// Local storage for the admin access key. The operations team enters the shared
// key once; it is sent on every admin request.

const ADMIN_KEY = "rm_admin_key";

export function getAdminKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ADMIN_KEY);
}

export function setAdminKey(key: string): void {
  window.localStorage.setItem(ADMIN_KEY, key);
}

export function clearAdminKey(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ADMIN_KEY);
}
