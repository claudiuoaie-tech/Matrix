"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  LayoutGrid,
  Users,
  Building2,
  Radio,
  ArrowLeft,
  Wifi,
  WifiOff,
  LogOut,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { auth, admin, ApiError } from "@/lib/api";
import type {
  IncomingMessage,
  MessageChannel,
  MessageTemplate,
  OutboundMedia,
} from "@/lib/types";
import { getAdminKey, setAdminKey, clearAdminKey } from "@/lib/adminSession";
import { useRotaEvents } from "@/lib/useRotaEvents";
import BoardGrid from "@/components/admin/BoardGrid";
import WorkersManager from "@/components/admin/WorkersManager";
import ClientsManager from "@/components/admin/ClientsManager";
import BroadcastEngine from "@/components/admin/BroadcastEngine";

type Tab = "rota" | "workers" | "clients" | "broadcast";
type Gate = "checking" | "out" | "in";

export default function AdminPage() {
  const [gate, setGate] = useState<Gate>("checking");

  // On mount, re-validate any stored key so a revoked/changed key kicks the
  // operator back to the login screen.
  useEffect(() => {
    const key = getAdminKey();
    if (!key) {
      setGate("out");
      return;
    }
    auth
      .adminLogin(key)
      .then(() => setGate("in"))
      .catch(() => {
        clearAdminKey();
        setGate("out");
      });
  }, []);

  if (gate === "checking") {
    return (
      <main className="flex-1 grid place-items-center">
        <Loader2 className="animate-spin text-muted" />
      </main>
    );
  }

  if (gate === "out") {
    return <AdminLogin onSuccess={() => setGate("in")} />;
  }

  return <AdminConsole onSignOut={() => setGate("out")} />;
}

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.adminLogin(key.trim());
      setAdminKey(key.trim());
      onSuccess();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Incorrect admin key"
          : err instanceof Error
          ? err.message
          : "Could not sign in"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex-1 flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground mb-6"
        >
          <ArrowLeft size={16} /> Back
        </Link>
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="grid place-items-center w-12 h-12 rounded-xl bg-indigo-50 text-brand mb-4">
            <ShieldCheck size={24} />
          </div>
          <h1 className="text-xl font-bold mb-1">Admin sign in</h1>
          <p className="text-sm text-muted mb-5">
            Enter the admin access key to open the console.
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Access key</label>
              <input
                type="password"
                autoFocus
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !key.trim()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {busy && <Loader2 size={18} className="animate-spin" />}
              Sign in
            </button>
            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
            )}
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-muted">
          Dev key: <span className="font-mono">dev-admin-key</span>
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Authenticated console
// ---------------------------------------------------------------------------

function AdminConsole({ onSignOut }: { onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("rota");
  const { connected, lastEvent } = useRotaEvents();

  // Live Inbox state is owned here (not inside BroadcastEngine) so the unread
  // badge on the Broadcast Engine tab updates in real time even while the
  // operator is on another tab — the console is always mounted, the tab panes
  // are not.
  const [messages, setMessages] = useState<IncomingMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [loadingInbox, setLoadingInbox] = useState(true);
  const [marking, setMarking] = useState(false);
  // Open WhatsApp 24h windows (phone → ISO expiry) and the approved template
  // catalog — together they let the inbox switch a WhatsApp thread between
  // free-text (in window) and template-only (out of window) composing.
  const [windows, setWindows] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);

  const loadInbox = useCallback(() => {
    admin
      .messages(200)
      .then((r) => {
        setMessages(r.messages);
        setUnread(r.unread);
        setWindows(r.windows ?? {});
      })
      .finally(() => setLoadingInbox(false));
  }, []);

  useEffect(loadInbox, [loadInbox]);

  // Load the approved WhatsApp template catalog once.
  useEffect(() => {
    admin
      .messageTemplates()
      .then((r) => setTemplates(r.templates))
      .catch(() => {});
  }, []);

  // A new inbound text arrived over SSE — refresh the feed + unread count.
  useEffect(() => {
    if (lastEvent?.type === "message.received") loadInbox();
  }, [lastEvent, loadInbox]);

  const markAll = useCallback(async () => {
    setMarking(true);
    try {
      await admin.markAllMessagesRead();
      setMessages((prev) => prev.map((m) => ({ ...m, isRead: true })));
      setUnread(0);
    } finally {
      setMarking(false);
    }
  }, []);

  // Send an outbound reply and prepend it (newest-first) for instant feedback.
  // The server also emits message.received, so other admins refresh too.
  const replyToMessage = useCallback(
    async (
      recipientPhone: string,
      body: string,
      channel: MessageChannel,
      media?: OutboundMedia
    ) => {
      const channelType = channel === "WHATSAPP" ? "whatsapp" : "sms";
      const { message } = await admin.replyToMessage(recipientPhone, body, channelType, media);
      setMessages((prev) => [message, ...prev]);
    },
    []
  );

  // Delete one message, then reload so the unread badge stays authoritative.
  const deleteMessage = useCallback(
    async (id: string) => {
      await admin.deleteMessage(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      loadInbox();
    },
    [loadInbox]
  );

  // Bulk-delete every read message (unread ones are kept), then resync.
  const clearReadHistory = useCallback(async () => {
    await admin.clearReadMessages();
    setMessages((prev) => prev.filter((m) => !m.isRead));
    loadInbox();
  }, [loadInbox]);

  // Batch-delete an explicit set of ids (multi-select), then resync the badge.
  const bulkDeleteMessages = useCallback(
    async (ids: string[]) => {
      await admin.bulkDeleteMessages(ids);
      const idSet = new Set(ids);
      setMessages((prev) => prev.filter((m) => !idSet.has(m.id)));
      loadInbox();
    },
    [loadInbox]
  );

  // Ad-hoc outbound to any number; prepend the logged OUTBOUND row for feedback.
  const sendDirectMessage = useCallback(
    async (
      phoneNumber: string,
      body: string,
      channel: MessageChannel,
      media?: OutboundMedia
    ) => {
      const channelType = channel === "WHATSAPP" ? "whatsapp" : "sms";
      const { message } = await admin.sendDirectMessage(phoneNumber, body, channelType, media);
      setMessages((prev) => [message, ...prev]);
    },
    []
  );

  // Out-of-session WhatsApp via an approved template; prepend the preview row and
  // reload so the freshly-opened window (if the contact replies) stays accurate.
  const sendTemplateMessage = useCallback(
    async (phoneNumber: string, templateKey: string, variables: Record<string, string>) => {
      const { message } = await admin.sendTemplate(phoneNumber, templateKey, variables);
      setMessages((prev) => [message, ...prev]);
    },
    []
  );

  function signOut() {
    clearAdminKey();
    onSignOut();
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: "rota", label: "Rota Board", icon: <LayoutGrid size={16} /> },
    { key: "workers", label: "Workers", icon: <Users size={16} /> },
    { key: "clients", label: "Clients", icon: <Building2 size={16} /> },
    { key: "broadcast", label: "Broadcast Engine", icon: <Radio size={16} />, badge: unread },
  ];

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-muted hover:text-foreground" title="Home">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-xl font-bold">Admin Console</h1>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              connected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-slate-50 text-slate-500"
            }`}
            title="Real-time updates"
          >
            {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {connected ? "Live" : "Offline"}
          </span>
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </header>

      <nav className="mb-5 flex gap-1 overflow-x-auto thin-scroll">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              tab === t.key
                ? "bg-brand text-white"
                : "bg-card text-muted hover:text-foreground border border-border"
            }`}
          >
            {t.icon}
            {t.label}
            {t.badge ? (
              <span
                className={`ml-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold tabular-nums ${
                  tab === t.key ? "bg-white/25 text-white" : "bg-rose-500 text-white"
                }`}
                title={`${t.badge} unread message${t.badge === 1 ? "" : "s"}`}
              >
                {t.badge > 99 ? "99+" : t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === "rota" && <BoardGrid lastEvent={lastEvent} />}
      {tab === "workers" && <WorkersManager />}
      {tab === "clients" && <ClientsManager />}
      {tab === "broadcast" && (
        <BroadcastEngine
          messages={messages}
          unread={unread}
          loadingInbox={loadingInbox}
          marking={marking}
          onMarkAll={markAll}
          onReply={replyToMessage}
          onDelete={deleteMessage}
          onClearRead={clearReadHistory}
          onBulkDelete={bulkDeleteMessages}
          onSendDirect={sendDirectMessage}
          windows={windows}
          templates={templates}
          onSendTemplate={sendTemplateMessage}
        />
      )}
    </main>
  );
}
