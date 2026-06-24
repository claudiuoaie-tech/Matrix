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
} from "lucide-react";
import { admin } from "@/lib/api";
import type {
  BoardCell,
  ClientLite,
  IncomingMessage,
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
}: {
  messages: IncomingMessage[];
  unread: number;
  loadingInbox: boolean;
  marking: boolean;
  onMarkAll: () => void;
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
}: {
  messages: IncomingMessage[];
  loading: boolean;
  unread: number;
  marking: boolean;
  onMarkAll: () => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="font-semibold">Live Inbox</h3>
          <p className="text-xs text-muted">
            {messages.length} message{messages.length === 1 ? "" : "s"}
            {unread > 0 ? ` · ${unread} unread` : ""}
          </p>
        </div>
        <button
          onClick={onMarkAll}
          disabled={marking || unread === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {marking ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
          Mark all as read
        </button>
      </div>

      <div className="max-h-[28rem] overflow-y-auto thin-scroll">
        {loading ? (
          <div className="grid place-items-center py-12">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : messages.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted">
            <Inbox size={28} className="mx-auto mb-2 text-slate-300" />
            No messages yet. Inbound texts appear here in real time.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {messages.map((m) => (
              <MessageCard key={m.id} m={m} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MessageCard({ m }: { m: IncomingMessage }) {
  const known = !!m.workerName;
  return (
    <li className={`flex gap-3 px-4 py-3 transition-colors ${m.isRead ? "" : "bg-indigo-50/40"}`}>
      {/* Fixed-width unread marker column keeps read/unread rows aligned. */}
      <span className="mt-1.5 flex h-2 w-2 shrink-0">
        {!m.isRead && <span className="h-2 w-2 rounded-full bg-brand" title="Unread" />}
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
          <span className="ml-auto shrink-0 text-[11px] text-muted">
            {relativeTime(m.receivedAt)}
          </span>
        </div>
        {known && <p className="font-mono text-[11px] text-muted">{m.fromNumber}</p>}
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
          {m.messageBody}
        </p>
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
