"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Send,
  Users,
  CheckCheck,
  CalendarClock,
  Eraser,
  ArrowRight,
  ArrowLeft,
  Building2,
  ChevronDown,
  Radio,
  Inbox,
  MessageSquare,
  MessageCircle,
  Reply,
  Trash2,
  X,
  Plus,
} from "lucide-react";
import { admin } from "@/lib/api";
import type {
  BoardCell,
  ClientLite,
  IncomingMessage,
  MessageChannel,
  RecipientCandidate,
} from "@/lib/types";
import { POOL_LABELS, SLOT_LABELS, formatDate } from "@/lib/ui";
import { STATUS_STYLES, cellText } from "@/lib/boardUi";

interface ShiftOption {
  id: string;
  label: string;
}

interface ClientGroup {
  key: string;
  name: string;
  pool: RecipientCandidate["clientPool"] | null;
  workers: RecipientCandidate[];
}

export default function BroadcastEngine({
  messages,
  unread,
  loadingInbox,
  marking,
  onMarkAll,
  onReply,
  onDelete,
  onClearRead,
  onBulkDelete,
  onSendDirect,
}: {
  messages: IncomingMessage[];
  unread: number;
  loadingInbox: boolean;
  marking: boolean;
  onMarkAll: () => void;
  onReply: (recipientPhone: string, body: string, channel: MessageChannel) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClearRead: () => Promise<void>;
  onBulkDelete: (ids: string[]) => Promise<void>;
  onSendDirect: (phoneNumber: string, body: string, channel: MessageChannel) => Promise<void>;
}) {
  // The inbox feed/unread/mark-all state is owned by the parent AdminConsole so
  // the unread badge stays live on the Broadcast Engine tab even when another
  // tab is open. This component just renders what it's given.
  const [view, setView] = useState<"broadcast" | "inbox">("broadcast");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* View switch: Broadcast composer vs. Live Inbox */}
      <div className="flex gap-1.5 rounded-2xl border border-border bg-card p-1.5">
        <ViewTab
          active={view === "broadcast"}
          onClick={() => setView("broadcast")}
          icon={<Radio size={15} />}
          label="Broadcast"
        />
        <ViewTab
          active={view === "inbox"}
          onClick={() => setView("inbox")}
          icon={<Inbox size={15} />}
          label="Live Inbox"
          badge={unread}
        />
      </div>

      {view === "broadcast" ? (
        <BroadcastComposer />
      ) : (
        <InboxPane
          messages={messages}
          loading={loadingInbox}
          unread={unread}
          marking={marking}
          onMarkAll={onMarkAll}
          onReply={onReply}
          onDelete={onDelete}
          onClearRead={onClearRead}
          onBulkDelete={onBulkDelete}
          onSendDirect={onSendDirect}
        />
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition ${
        active ? "bg-brand text-white" : "text-muted hover:text-foreground"
      }`}
    >
      {icon}
      {label}
      {badge ? (
        <span
          className={`ml-1 grid min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold ${
            active ? "bg-white/25 text-white" : "bg-rose-500 text-white"
          }`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function BroadcastComposer() {
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 — compose
  const [message, setMessage] = useState(
    "Urgent shift tomorrow at Client A, 8am. Reply 1 to accept."
  );
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [channel, setChannel] = useState<"SMS" | "WHATSAPP">("SMS");

  // Step 2 — recipients
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [date, setDate] = useState("");
  const [candidates, setCandidates] = useState<RecipientCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  // Each worker's rota-board cell for the target date (keyed by workerId).
  // This is the source of truth for the "unallocated" filter.
  const [dayCells, setDayCells] = useState<Record<string, BoardCell>>({});
  // Which client groups are shown. Empty = all clients.
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set());
  const [clientMenuOpen, setClientMenuOpen] = useState(false);
  const clientMenuRef = useRef<HTMLDivElement>(null);

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Clients (for grouping) + shift options (optional proposal link).
  useEffect(() => {
    admin.clients().then(setClients);
    admin.rota().then((r) => {
      const opts: ShiftOption[] = [];
      r.clients.forEach((c) =>
        c.shifts.forEach((s) =>
          opts.push({
            id: s.id,
            label: `${c.companyName} · ${formatDate(s.date)} · ${SLOT_LABELS[s.slot]}`,
          })
        )
      );
      setShifts(opts);
    });
  }, []);

  const loadRecipients = useCallback(() => {
    setLoadingRecipients(true);
    admin
      .recipients(undefined, date || undefined)
      .then((list) => {
        setCandidates(list);
        setSelected((prev) => new Set([...prev].filter((id) => list.some((c) => c.id === id))));
      })
      .finally(() => setLoadingRecipients(false));
  }, [date]);

  useEffect(loadRecipients, [loadRecipients]);

  // Pull the board cells for the target date so "unallocated" reflects the grid.
  useEffect(() => {
    if (!date) {
      setDayCells({});
      return;
    }
    admin.board(undefined, date).then((b) => {
      const map: Record<string, BoardCell> = {};
      for (const w of b.workers) {
        const c = w.cells[date];
        if (c) map[w.id] = c;
      }
      setDayCells(map);
    });
  }, [date]);

  // A worker is "unallocated" for the date when their cell is blank OR AVAILABLE
  // without a scheduled start time. SCHEDULED / SICK / REST / HOLIDAY / CANCELLED
  // / NO_SHOW / REJECTED never count as unallocated.
  function isUnallocated(workerId: string): boolean {
    const cell = dayCells[workerId];
    if (!cell) return true;
    return cell.status === "AVAILABLE" && !cell.startTime;
  }

  // Group eligible workers under each Client (by the pool the client draws from).
  const groups = useMemo<ClientGroup[]>(() => {
    const covered = new Set(clients.map((c) => c.pool));
    const byClient: ClientGroup[] = clients.map((c) => ({
      key: c.id,
      name: c.companyName,
      pool: c.pool,
      workers: candidates.filter((w) => w.clientPool === c.pool),
    }));
    const ungrouped = candidates.filter((w) => !covered.has(w.clientPool));
    if (ungrouped.length) {
      byClient.push({ key: "__other", name: "Other workers", pool: null, workers: ungrouped });
    }
    return byClient.filter((g) => g.workers.length > 0);
  }, [clients, candidates]);

  // Groups actually shown, after the client filter (empty filter = all).
  const visibleGroups = useMemo(
    () => (clientFilter.size ? groups.filter((g) => clientFilter.has(g.key)) : groups),
    [groups, clientFilter]
  );

  // Unique worker ids across the visible groups (bulk selects act on these only).
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of visibleGroups) for (const w of g.workers) ids.add(w.id);
    return ids;
  }, [visibleGroups]);

  // Hiding a client drops its workers from the selection: keep only ids that are
  // currently visible. (No-op return when nothing changed avoids a render loop.)
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleIds]);

  function toggleClient(id: string) {
    setClientFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Close the client dropdown on an outside click.
  useEffect(() => {
    if (!clientMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (clientMenuRef.current && !clientMenuRef.current.contains(e.target as Node)) {
        setClientMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [clientMenuOpen]);

  const clientFilterLabel =
    clientFilter.size === 0
      ? "All clients"
      : `${clientFilter.size} client${clientFilter.size === 1 ? "" : "s"}`;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(g: ClientGroup) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = g.workers.every((w) => next.has(w.id));
      for (const w of g.workers) {
        if (allOn) next.delete(w.id);
        else next.add(w.id);
      }
      return next;
    });
  }

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Bulk selects act on the workers currently visible (after the client filter).
  const selectAll = () => setSelected(new Set(visibleIds));
  // Select ONLY visible workers who are unallocated for the chosen date (blank or
  // AVAILABLE-without-a-shift). Already-scheduled or unavailable workers are left
  // unselected. Replaces the current selection.
  const selectUnallocated = () => {
    if (!date) return;
    setSelected(new Set([...visibleIds].filter((id) => isUnallocated(id))));
  };
  const clearSelection = () => setSelected(new Set());

  async function dispatch() {
    setSending(true);
    setResult(null);
    try {
      const res = await admin.broadcast(message, [...selected], shiftId || undefined, channel);
      setResult(
        `Sent to ${res.sent} worker${res.sent === 1 ? "" : "s"} via ${
          channel === "WHATSAPP" ? "WhatsApp" : "SMS"
        }` + (res.proposed ? ` · ${res.proposed} proposed allocation(s) created` : "")
      );
      setSelected(new Set());
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Stepper header */}
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
        <Step n={1} label="Compose" active={step === 1} done={step > 1} />
        <div className="h-px flex-1 bg-border" />
        <Step n={2} label="Recipients & send" active={step === 2} done={false} />
      </div>

      {step === 1 ? (
        /* ---- Step 1: message ------------------------------------------- */
        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="mb-1 font-semibold">Compose your broadcast</h3>
          <p className="mb-3 text-sm text-muted">
            Write the SMS workers will receive. Replies of “1” / “YES” are handled automatically.
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={8}
            className="w-full resize-none rounded-xl border border-border bg-white p-3 text-sm outline-none focus:border-brand"
            placeholder="Type your broadcast…"
          />
          <p className="mt-1 text-xs text-muted">{message.length} characters</p>

          {/* Channel selector */}
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-muted">Send via</label>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setChannel("SMS")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  channel === "SMS" ? "bg-brand text-white" : "text-muted hover:text-foreground"
                }`}
              >
                <MessageSquare size={15} /> SMS
              </button>
              <button
                type="button"
                onClick={() => setChannel("WHATSAPP")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  channel === "WHATSAPP"
                    ? "bg-emerald-600 text-white"
                    : "text-muted hover:text-foreground"
                }`}
              >
                <MessageCircle size={15} /> WhatsApp
              </button>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-muted">
              Link to a shift (optional) — creates Proposed allocations so replies are tracked
            </label>
            <select
              value={shiftId}
              onChange={(e) => setShiftId(e.target.value)}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
            >
              <option value="">No shift link (message only)</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setStep(2)}
            disabled={!message.trim()}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            Next: choose recipients <ArrowRight size={18} />
          </button>
        </section>
      ) : (
        /* ---- Step 2: recipients & dispatch ----------------------------- */
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-foreground"
            >
              <ArrowLeft size={15} /> Back to message
            </button>
            <span className="inline-flex items-center gap-1 text-sm font-medium text-muted">
              <Users size={14} /> {selected.size} selected
            </span>
          </div>

          {/* Date + filters */}
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">
                Date (for “unallocated” filter &amp; holiday exclusion)
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <div className="flex items-end">
              <p className="text-xs text-muted">
                Workers on holiday for the chosen date are automatically excluded.
              </p>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={selectAll}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
            >
              <CheckCheck size={14} /> Select all
            </button>
            <button
              onClick={selectUnallocated}
              disabled={!date}
              title={date ? "" : "Pick a date first"}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              <CalendarClock size={14} />
              {date ? `Select unallocated for ${formatDate(date)}` : "Select unallocated for [date]"}
            </button>

            {/* Client filter — single dropdown, multi-select (empty = all) */}
            <div ref={clientMenuRef} className="relative">
              <button
                onClick={() => setClientMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
              >
                <Building2 size={14} /> {clientFilterLabel}
                <ChevronDown
                  size={14}
                  className={`text-muted transition-transform ${clientMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              {clientMenuOpen && (
                <div className="absolute left-0 z-20 mt-1 w-60 rounded-xl border border-border bg-white p-1 shadow-lg">
                  <button
                    onClick={() => setClientFilter(new Set())}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                  >
                    <input type="checkbox" readOnly checked={clientFilter.size === 0} className="h-4 w-4 accent-[var(--brand)]" />
                    <span className="font-medium">All clients</span>
                  </button>
                  <div className="my-1 h-px bg-border" />
                  {clients.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => toggleClient(c.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        readOnly
                        checked={clientFilter.has(c.id)}
                        className="h-4 w-4 accent-[var(--brand)]"
                      />
                      <span className="truncate">{c.companyName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={clearSelection}
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-50"
            >
              <Eraser size={14} /> Clear
            </button>
          </div>

          {/* Recipients grouped by Client */}
          <div className="max-h-72 overflow-y-auto thin-scroll rounded-xl border border-border">
            {loadingRecipients ? (
              <div className="grid place-items-center py-10">
                <Loader2 className="animate-spin text-muted" />
              </div>
            ) : visibleGroups.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted">
                No eligible workers (holidays excluded).
              </p>
            ) : (
              <div className="divide-y divide-border">
                {visibleGroups.map((g) => {
                  const allOn = g.workers.every((w) => selected.has(w.id));
                  const someOn = !allOn && g.workers.some((w) => selected.has(w.id));
                  const isCollapsed = collapsed.has(g.key);
                  return (
                    <div key={g.key}>
                      <div className="flex items-center gap-2 bg-slate-50/70 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = someOn;
                          }}
                          onChange={() => toggleGroup(g)}
                          className="h-4 w-4 accent-[var(--brand)]"
                        />
                        <Building2 size={15} className="text-muted" />
                        <span className="flex-1 text-sm font-semibold">{g.name}</span>
                        <span className="text-[11px] text-muted">
                          {g.pool ? POOL_LABELS[g.pool] : "—"} · {g.workers.length}
                        </span>
                        <button
                          onClick={() => toggleCollapse(g.key)}
                          className="text-muted hover:text-foreground"
                          title={isCollapsed ? "Expand" : "Collapse"}
                        >
                          <ChevronDown
                            size={16}
                            className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                          />
                        </button>
                      </div>
                      {!isCollapsed && (
                        <ul className="divide-y divide-border">
                          {g.workers.map((c) => {
                            const cell = date ? dayCells[c.id] : undefined;
                            const unalloc = date ? isUnallocated(c.id) : false;
                            return (
                              <li key={`${g.key}:${c.id}`}>
                                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 pl-8 hover:bg-slate-50">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(c.id)}
                                    onChange={() => toggle(c.id)}
                                    className="h-4 w-4 accent-[var(--brand)]"
                                  />
                                  <span className="flex-1 text-sm">{c.name}</span>
                                  {date &&
                                    (unalloc ? (
                                      // Blank OR AVAILABLE-without-a-shift = unallocated.
                                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                                        unallocated
                                      </span>
                                    ) : cell ? (
                                      // Scheduled shift, or an unavailable status (sick/rest/etc.).
                                      <span
                                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                        style={{
                                          background: STATUS_STYLES[cell.status].bg,
                                          color: STATUS_STYLES[cell.status].fg,
                                        }}
                                      >
                                        {cellText(cell.status, cell.startTime, cell.label)}
                                      </span>
                                    ) : null)}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <button
            onClick={dispatch}
            disabled={sending || selected.size === 0 || !message.trim()}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            Dispatch to {selected.size} worker{selected.size === 1 ? "" : "s"}
          </button>
          {result && (
            <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {result}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Step({
  n,
  label,
  active,
  done,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${
          active || done ? "bg-brand text-white" : "bg-slate-100 text-muted"
        }`}
      >
        {n}
      </span>
      <span
        className={`text-sm font-medium ${active ? "text-foreground" : "text-muted"}`}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Inbox pane
// ---------------------------------------------------------------------------

function InboxPane({
  messages,
  loading,
  unread,
  marking,
  onMarkAll,
  onReply,
  onDelete,
  onClearRead,
  onBulkDelete,
  onSendDirect,
}: {
  messages: IncomingMessage[];
  loading: boolean;
  unread: number;
  marking: boolean;
  onMarkAll: () => void;
  onReply: (recipientPhone: string, body: string, channel: MessageChannel) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClearRead: () => Promise<void>;
  onBulkDelete: (ids: string[]) => Promise<void>;
  onSendDirect: (phoneNumber: string, body: string, channel: MessageChannel) => Promise<void>;
}) {
  // Client-side view filter (Feature 3). "unread" shows only inbound un-read.
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [clearing, setClearing] = useState(false);
  // Multi-select deletion (Phase 2, Feature 1).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const masterRef = useRef<HTMLInputElement>(null);
  // Ad-hoc "New message" composer modal (Phase 2, Feature 2).
  const [composeOpen, setComposeOpen] = useState(false);

  const visible = filter === "unread" ? messages.filter((m) => !m.isRead) : messages;
  const readCount = messages.filter((m) => m.isRead).length;

  // Drop selections for messages that no longer exist (after deletes / reloads).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(messages.map((m) => m.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [messages]);

  const visibleIds = visible.map((m) => m.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id));

  // Reflect the "some but not all" state on the master checkbox.
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    try {
      await onBulkDelete(ids);
      setSelected(new Set());
    } finally {
      setBulkDeleting(false);
    }
  }

  async function clearRead() {
    if (!window.confirm(`Delete all ${readCount} read message(s)? This cannot be undone.`)) {
      return;
    }
    setClearing(true);
    try {
      await onClearRead();
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="font-semibold">Live Inbox</h3>
          <p className="text-xs text-muted">
            {messages.length} message{messages.length === 1 ? "" : "s"}
            {unread > 0 ? ` · ${unread} unread` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Phase 2, Feature 2 — ad-hoc outbound to any number */}
          <button
            onClick={() => setComposeOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            <Plus size={14} /> New message
          </button>
          {/* Feature 3 — All / Unread filter toggle */}
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <FilterTab active={filter === "all"} onClick={() => setFilter("all")} label="All" />
            <FilterTab
              active={filter === "unread"}
              onClick={() => setFilter("unread")}
              label={`Unread${unread > 0 ? ` (${unread})` : ""}`}
            />
          </div>
          <button
            onClick={onMarkAll}
            disabled={marking || unread === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {marking ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
            Mark all read
          </button>
          {/* Feature 2 (prior phase) — bulk clear read history */}
          <button
            onClick={clearRead}
            disabled={clearing || readCount === 0}
            title={readCount === 0 ? "No read messages to clear" : ""}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Clear read history
          </button>
        </div>
      </div>

      {/* Phase 2, Feature 1 — select-all + delete-selected bar */}
      {!loading && visible.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-slate-50/60 px-4 py-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-muted">
            <input
              ref={masterRef}
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAllVisible}
              className="h-4 w-4 accent-[var(--brand)]"
            />
            {selected.size > 0 ? `${selected.size} selected` : "Select all"}
          </label>
          {selected.size > 0 && (
            <button
              onClick={deleteSelected}
              disabled={bulkDeleting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {bulkDeleting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Delete selected ({selected.size})
            </button>
          )}
        </div>
      )}

      <div className="max-h-[28rem] overflow-y-auto thin-scroll">
        {loading ? (
          <div className="grid place-items-center py-12">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted">
            <Inbox size={28} className="mx-auto mb-2 text-slate-300" />
            {filter === "unread"
              ? "No unread messages."
              : "No messages yet. Inbound texts appear here in real time."}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((m) => (
              <MessageCard
                key={m.id}
                m={m}
                selected={selected.has(m.id)}
                onToggleSelect={toggleSelect}
                onReply={onReply}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>

      {composeOpen && (
        <NewMessageModal onClose={() => setComposeOpen(false)} onSend={onSendDirect} />
      )}
    </section>
  );
}

/**
 * Ad-hoc outbound composer (Phase 2, Feature 2). Sends to ANY number via
 * /api/admin/messages/send-direct — recipient need not be an existing worker.
 */
function NewMessageModal({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (phoneNumber: string, body: string, channel: MessageChannel) => Promise<void>;
}) {
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<MessageChannel>("SMS");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const p = phone.trim();
    const b = body.trim();
    if (!p || !b) {
      setError("Enter a phone number and a message.");
      return;
    }
    // Light client-side guard; the number should ideally be E.164 (e.g. +447…).
    if (!/^\+?[0-9\s()-]{6,}$/.test(p)) {
      setError("Enter a valid phone number, ideally in full international form like +447700900123.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend(p, b, channel);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">New message</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground" title="Close">
            <X size={18} />
          </button>
        </div>

        <label className="mb-1 block text-xs font-medium text-muted">Phone number</label>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoFocus
          inputMode="tel"
          placeholder="+447700900123"
          className="mb-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <p className="mb-3 text-[11px] text-muted">
          Include the country code (e.g. +44 for the UK). Any number works — it need not be a saved worker.
        </p>

        <label className="mb-1 block text-xs font-medium text-muted">Send via</label>
        <div className="mb-3 inline-flex rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => setChannel("SMS")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              channel === "SMS" ? "bg-brand text-white" : "text-muted hover:text-foreground"
            }`}
          >
            <MessageSquare size={15} /> SMS
          </button>
          <button
            type="button"
            onClick={() => setChannel("WHATSAPP")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              channel === "WHATSAPP"
                ? "bg-emerald-600 text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            <MessageCircle size={15} /> WhatsApp
          </button>
        </div>

        <label className="mb-1 block text-xs font-medium text-muted">Message</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Type your message…"
          className="w-full resize-none rounded-lg border border-border bg-white p-3 text-sm outline-none focus:border-brand"
        />

        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || !phone.trim() || !body.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active ? "bg-brand text-white" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function MessageCard({
  m,
  selected,
  onToggleSelect,
  onReply,
  onDelete,
}: {
  m: IncomingMessage;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onReply: (recipientPhone: string, body: string, channel: MessageChannel) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const known = !!m.workerName;
  const outbound = m.direction === "OUTBOUND";

  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendReply() {
    const body = replyText.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      // Reply on the same channel the message belongs to, to the contact number.
      await onReply(m.fromNumber, body, m.channel);
      setReplyText("");
      setReplyOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete(m.id);
    } catch {
      setDeleting(false); // keep the row if the delete failed
    }
  }

  return (
    <li
      className={`group px-4 py-3 transition-colors ${
        selected
          ? "bg-indigo-50"
          : outbound
          ? "bg-emerald-50/40"
          : m.isRead
          ? ""
          : "bg-indigo-50/40"
      }`}
    >
      <div className="flex gap-3">
        {/* Selection checkbox (Phase 2, Feature 1). */}
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(m.id)}
          aria-label="Select message"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]"
        />
        {/* Fixed-width marker column keeps rows aligned. */}
        <span className="mt-1.5 flex h-2 w-2 shrink-0">
          {!m.isRead && !outbound && (
            <span className="h-2 w-2 rounded-full bg-brand" title="Unread" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`truncate text-sm ${
                known ? "font-bold text-foreground" : "font-mono text-foreground"
              }`}
            >
              {known ? m.workerName : m.fromNumber}
            </span>
            <ChannelBadge channel={m.channel} />
            {outbound && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                Sent
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-muted">
              {relativeTime(m.receivedAt)}
            </span>
          </div>
          {known && <p className="font-mono text-[11px] text-muted">{m.fromNumber}</p>}
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
            {m.messageBody}
          </p>

          {/* Row actions — subtle, surfaced on hover/focus. */}
          <div className="mt-1.5 flex items-center gap-3 text-muted opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
            <button
              onClick={() => setReplyOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-[11px] font-medium hover:text-brand"
            >
              <Reply size={13} /> Reply
            </button>
            <button
              onClick={remove}
              disabled={deleting}
              title="Delete message"
              className="inline-flex items-center gap-1 text-[11px] font-medium hover:text-rose-600 disabled:opacity-50"
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </button>
          </div>

          {/* Inline reply composer */}
          {replyOpen && (
            <div className="mt-2 rounded-xl border border-border bg-white p-2">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={2}
                autoFocus
                placeholder={`Reply via ${m.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}…`}
                className="w-full resize-none rounded-lg border border-border p-2 text-sm outline-none focus:border-brand"
              />
              {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setReplyOpen(false);
                    setError(null);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-slate-50"
                >
                  <X size={13} /> Cancel
                </button>
                <button
                  onClick={sendReply}
                  disabled={sending || !replyText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ChannelBadge({ channel }: { channel: IncomingMessage["channel"] }) {
  if (channel === "WHATSAPP") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
        <MessageCircle size={11} /> WhatsApp
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
      <MessageSquare size={11} /> SMS
    </span>
  );
}

/** Relative time: "Just now", "5m ago", "3h ago", else "23 Jun, 12:40". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "Just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
