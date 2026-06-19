"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Plus, Trash2, Loader2 } from "lucide-react";
import { admin } from "@/lib/api";
import type { ShiftTemplate } from "@/lib/types";

/** Manage a client's reusable shift patterns / templates. */
export default function TemplatesModal({
  clientId,
  clientName,
  onClose,
}: {
  clientId: string;
  clientName: string;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    admin.templates(clientId).then(setTemplates).finally(() => setLoading(false));
  }, [clientId]);

  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await admin.createTemplate(clientId, { name, startTime: start, endTime: end });
      setName("");
      setStart("");
      setEnd("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await admin.deleteTemplate(id);
    load();
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-semibold">Shift patterns</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">{clientName}</p>

        {loading ? (
          <div className="grid place-items-center py-8">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : (
          <ul className="mb-4 space-y-1.5">
            {templates.length === 0 && (
              <li className="text-sm text-muted">No templates yet.</li>
            )}
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-border bg-white px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{t.name}</span>{" "}
                  <span className="text-muted">
                    {t.startTime}–{t.endTime}
                  </span>
                </span>
                <button
                  onClick={() => remove(t.id)}
                  className="text-rose-500 hover:text-rose-700"
                  title="Delete"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
          <div>
            <label className="block text-[11px] font-medium text-muted mb-0.5">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Early"
              className="w-full rounded-lg border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted mb-0.5">Start</label>
            <input
              required
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-lg border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted mb-0.5">End</label>
            <input
              required
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-lg border border-border bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          </button>
        </form>
      </div>
    </div>
  );
}
