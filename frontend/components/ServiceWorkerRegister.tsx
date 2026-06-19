"use client";

import { useEffect } from "react";

/**
 * Manages the PWA service worker.
 *
 * In production it registers `/sw.js` so workers can install the app and use it
 * offline. In development it does the opposite — it unregisters any existing
 * service worker and clears its caches, because a caching SW serving stale dev
 * chunks breaks Next.js hot-reload (tabs hang on refresh). Renders nothing.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const isProd = process.env.NODE_ENV === "production";

    if (!isProd) {
      // Dev: tear down any controlling SW + caches so refreshes aren't blocked.
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (typeof caches !== "undefined") {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.warn("SW registration failed:", err));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
