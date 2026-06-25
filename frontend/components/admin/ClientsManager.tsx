"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, X, AlertTriangle } from "lucide-react";
import { admin } from "@/lib/api";
import type { ClientLite, ClientPool } from "@/lib/types";
import { POOL_LABELS } from "@/lib/ui";

const POOLS: ClientPool[] = ["POOL_A", "POOL_B", "POOL_C"];

/**
 * Clients management view (Phase 4). Full CRUD over the clients table — name,
 * site address, main phone, and the worker pool the client draws from.
 */
export default function ClientsManager() {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ClientLite | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClientLite | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    admin
      .clients()
      .then(setClients)
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await admin.deleteClient(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      // Surfaces the backend's 409 "shifts still assigned" safety message.
      setDeleteError(err instanceof Error ? err.message : "Could not delete client");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-20">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h3 className="font-semibold">Clients ({clients.length})</h3>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white"
        >
          <Plus size={16} /> Add client
        </button>
      </header>

      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-5 py-2 font-medium">Site address</th>
              <th className="px-5 py-2 font-medium">Phone</th>
              <th className="px-5 py-2 font-medium">Pool</th>
              <th className="px-5 py-2 font-medium">Workers</th>
              <th className="px-5 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-sm text-muted">
                  No clients yet. Add your first client to start allocating workers.
                </td>
              </tr>
            )}
            {clients.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-5 py-2.5 font-medium">{c.companyName}</td>
                <td className="px-5 py-2.5 text-muted">{c.address}</td>
                <td className="px-5 py-2.5 font-mono text-xs text-muted">{c.phone || "—"}</td>
                <td className="px-5 py-2.5">{POOL_LABELS[c.pool]}</td>
                <td className="px-5 py-2.5">{c.workerCount ?? 0}</td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => setEditing(c)}
                      title="Edit"
                      className="rounded-md border border-border p-1.5 text-muted hover:text-foreground"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(c);
                      }}
                      title="Delete"
                      className="rounded-md border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <ClientModal
          client={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            load();
          }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-100 text-rose-600">
                <AlertTriangle size={18} />
              </span>
              <h3 className="font-semibold">Delete client?</h3>
            </div>
            <p className="mb-4 text-sm text-foreground">
              Delete <span className="font-semibold">{deleteTarget.companyName}</span>? This
              can&apos;t be undone. Clients with shifts still assigned are protected.
            </p>
            {deleteError && (
              <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {deleteError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Delete client
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClientModal({
  client,
  onClose,
  onSaved,
}: {
  client: ClientLite | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [companyName, setCompanyName] = useState(client?.companyName ?? "");
  const [address, setAddress] = useState(client?.address ?? "");
  const [phone, setPhone] = useState(client?.phone ?? "");
  const [pool, setPool] = useState<ClientPool>(client?.pool ?? "POOL_A");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        companyName: companyName.trim(),
        address: address.trim(),
        phone: phone.trim() || null,
        pool,
      };
      if (client) await admin.updateClient(client.id, payload);
      else await admin.createClient(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">{client ? "Edit client" : "Add client"}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Client name</label>
            <input
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Northgate Logistics"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Site address</label>
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="12 Dock Road, Manchester"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              Main phone number (optional)
            </label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+441612345678"
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-mono outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Worker pool</label>
            <select
              value={pool}
              onChange={(e) => setPool(e.target.value as ClientPool)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            >
              {POOLS.map((p) => (
                <option key={p} value={p}>
                  {POOL_LABELS[p]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted">
              Workers allocated to this client are drawn from this pool.
            </p>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {client ? "Save changes" : "Create client"}
          </button>
        </form>
      </div>
    </div>
  );
}
