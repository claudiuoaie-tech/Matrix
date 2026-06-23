import Link from "next/link";
import { CalendarDays, LayoutDashboard, Smartphone, Radio } from "lucide-react";

export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-3 justify-center mb-2">
          <div className="grid place-items-center w-11 h-11 rounded-xl bg-brand text-white">
            <CalendarDays size={24} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Matrix</h1>
        </div>
        <p className="text-center text-muted mb-10">
          Temporary worker rota &amp; shift communications. Choose a view to get
          started — this toggle is for local development testing.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <Link
            href="/worker/login"
            className="group rounded-2xl border border-border bg-card p-6 shadow-sm transition hover:shadow-md hover:border-brand"
          >
            <div className="grid place-items-center w-12 h-12 rounded-xl bg-indigo-50 text-brand mb-4">
              <Smartphone size={24} />
            </div>
            <h2 className="text-lg font-semibold mb-1">Worker Portal</h2>
            <p className="text-sm text-muted">
              Frictionless SMS login, weekly availability, your schedule, and
              holiday requests. Mobile-first PWA.
            </p>
            <span className="mt-4 inline-block text-sm font-medium text-brand group-hover:underline">
              Open worker portal →
            </span>
          </Link>

          <Link
            href="/admin"
            className="group rounded-2xl border border-border bg-card p-6 shadow-sm transition hover:shadow-md hover:border-brand"
          >
            <div className="grid place-items-center w-12 h-12 rounded-xl bg-indigo-50 text-brand mb-4">
              <LayoutDashboard size={24} />
            </div>
            <h2 className="text-lg font-semibold mb-1">Admin Console</h2>
            <p className="text-sm text-muted">
              Live rota matrix, worker management, and the custom broadcast
              engine — with real-time updates.
            </p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand group-hover:underline">
              <Radio size={14} /> Open admin console →
            </span>
          </Link>
        </div>
      </div>
    </main>
  );
}
