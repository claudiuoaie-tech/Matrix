// Typed client for the Matrix Express API.

import { getToken } from "./session";
import { getAdminKey } from "./adminSession";
import type {
  AdminWorker,
  AvailabilityCell,
  BoardResponse,
  ClientLite,
  ClientPool,
  HolidayRequest,
  ImportSummary,
  InboxResponse,
  RecipientCandidate,
  RotaResponse,
  RotaStatus,
  ScheduleEntry,
  ShiftTemplate,
  WorkerBoardResponse,
  WorkerDocument,
  WorkerProfile,
  WorkerShift,
  WorkerStatus,
  DocType,
} from "./types";

export interface CellInput {
  workerId: string;
  date: string;
  status: RotaStatus;
  label?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  clientId?: string | null;
}

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; admin?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (opts.admin) {
    const key = getAdminKey();
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- Auth ------------------------------------------------------------------

export const auth = {
  requestOtp: (phone: string) =>
    request<{ ok: boolean; devCode?: string }>("/api/auth/otp/request", {
      method: "POST",
      body: { phone },
    }),
  verifyOtp: (phone: string, code: string) =>
    request<{ token: string; worker: WorkerProfile }>("/api/auth/otp/verify", {
      method: "POST",
      body: { phone, code },
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", auth: true }),
  adminLogin: (key: string) =>
    request<{ ok: boolean }>("/api/auth/admin/login", { method: "POST", body: { key } }),
};

// ---- Worker portal ---------------------------------------------------------

export const worker = {
  me: () => request<WorkerProfile>("/api/worker/me", { auth: true }),
  getAvailability: () =>
    request<AvailabilityCell[]>("/api/worker/availability", { auth: true }),
  saveAvailability: (availability: AvailabilityCell[]) =>
    request<{ ok: boolean; saved: number }>("/api/worker/availability", {
      method: "PUT",
      auth: true,
      body: { availability },
    }),
  schedule: () => request<ScheduleEntry[]>("/api/worker/schedule", { auth: true }),
  shifts: () => request<WorkerShift[]>("/api/worker/shifts", { auth: true }),
  respond: (allocationId: string, action: "accept" | "decline") =>
    request<{ ok: boolean; state: string }>(
      `/api/worker/allocations/${allocationId}/respond`,
      { method: "POST", auth: true, body: { action } }
    ),
  holidays: () => request<HolidayRequest[]>("/api/worker/holidays", { auth: true }),
  requestHoliday: (startDate: string, endDate: string, note?: string) =>
    request<HolidayRequest>("/api/worker/holidays", {
      method: "POST",
      auth: true,
      body: { startDate, endDate, note },
    }),
  board: (start?: string) =>
    request<WorkerBoardResponse>(
      `/api/worker/board${start ? `?start=${start}` : ""}`,
      { auth: true }
    ),
  setBoardCell: (date: string, status: RotaStatus) =>
    request<{ status: RotaStatus }>("/api/worker/board/cell", {
      method: "PUT",
      auth: true,
      body: { date, status },
    }),
};

// ---- Admin -----------------------------------------------------------------

export const admin = {
  rota: (weekStart?: string) =>
    request<RotaResponse>(
      `/api/admin/rota${weekStart ? `?weekStart=${weekStart}` : ""}`,
      { admin: true }
    ),
  workers: () => request<AdminWorker[]>("/api/admin/workers", { admin: true }),
  createWorker: (data: {
    name: string;
    phone: string;
    clientPool: ClientPool;
    rtwExpiryDate?: string | null;
    skills?: string[];
    email?: string | null;
  }) => request<AdminWorker>("/api/admin/workers", { method: "POST", admin: true, body: data }),
  updateWorker: (
    id: string,
    data: Partial<{
      name: string;
      phone: string;
      clientPool: ClientPool;
      status: WorkerStatus;
      rtwExpiryDate: string | null;
      skills: string[];
      email: string | null;
    }>
  ) =>
    request<AdminWorker>(`/api/admin/workers/${id}`, {
      method: "PUT",
      admin: true,
      body: data,
    }),

  // ---- CSV import / export ----
  importWorkers: (csv: string) =>
    request<ImportSummary>("/api/admin/workers/import", {
      method: "POST",
      admin: true,
      body: { csv },
    }),
  // Returns the raw CSV text (not JSON), with the admin key on the Authorization header.
  exportWorkers: async (): Promise<string> => {
    const key = getAdminKey();
    const res = await fetch(`${API_URL}/api/admin/workers/export`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);
    return res.text();
  },

  // ---- Worker document vault ----
  documents: (workerId: string) =>
    request<WorkerDocument[]>(`/api/admin/workers/${workerId}/documents`, { admin: true }),
  uploadDocument: (
    workerId: string,
    data: { docType: DocType; fileName: string; mimeType: string; data: string }
  ) =>
    request<WorkerDocument>(`/api/admin/workers/${workerId}/documents`, {
      method: "POST",
      admin: true,
      body: data,
    }),
  deleteDocument: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/documents/${id}`, { method: "DELETE", admin: true }),
  // Authenticated link for viewing/downloading a document (key rides as a query param).
  documentFileUrl: (id: string) => {
    const key = getAdminKey();
    return `${API_URL}/api/admin/documents/${id}/file${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  },
  nudge: (allocationId: string) =>
    request<{ ok: boolean; nudged: string }>(
      `/api/admin/allocations/${allocationId}/nudge`,
      { method: "POST", admin: true }
    ),
  recipients: (pool?: ClientPool, date?: string) => {
    const params = new URLSearchParams();
    if (pool) params.set("pool", pool);
    if (date) params.set("date", date);
    const qs = params.toString();
    return request<RecipientCandidate[]>(
      `/api/admin/broadcast/recipients${qs ? `?${qs}` : ""}`,
      { admin: true }
    );
  },
  broadcast: (
    messageBody: string,
    workerIds: string[],
    shiftId?: string,
    channel: "SMS" | "WHATSAPP" = "SMS"
  ) =>
    request<{ ok: boolean; broadcastId: string; sent: number; proposed: number; channel: string }>(
      "/api/admin/broadcast",
      { method: "POST", admin: true, body: { messageBody, workerIds, shiftId, channel } }
    ),
  // ---- Live Inbox ----
  messages: (limit?: number) =>
    request<InboxResponse>(
      `/api/admin/messages${limit ? `?limit=${limit}` : ""}`,
      { admin: true }
    ),
  markAllMessagesRead: () =>
    request<{ ok: boolean; updated: number }>("/api/admin/messages/read-all", {
      method: "POST",
      admin: true,
    }),

  // EventSource cannot set headers, so the admin key rides as a query param.
  eventsUrl: () => {
    const key = getAdminKey();
    return `${API_URL}/api/admin/events${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  },

  // ---- Planning board ----
  clients: () => request<ClientLite[]>("/api/admin/clients", { admin: true }),
  board: (clientId?: string, start?: string) => {
    const params = new URLSearchParams();
    if (clientId) params.set("clientId", clientId);
    if (start) params.set("start", start);
    const qs = params.toString();
    return request<BoardResponse>(`/api/admin/board${qs ? `?${qs}` : ""}`, {
      admin: true,
    });
  },
  setCell: (cell: CellInput, silent = false) =>
    request<{ smsSent?: boolean } & Record<string, unknown>>("/api/admin/board/cell", {
      method: "PUT",
      admin: true,
      body: { ...cell, silent },
    }),
  setCells: (cells: CellInput[], silent = false) =>
    request<{ ok: boolean; count: number; smsSent: number }>("/api/admin/board/cells", {
      method: "PUT",
      admin: true,
      body: { cells, silent },
    }),
  clearCell: (workerId: string, date: string) =>
    request<{ ok: boolean }>("/api/admin/board/cell", {
      method: "DELETE",
      admin: true,
      body: { workerId, date },
    }),
  cancelCell: (workerId: string, date: string, clientId?: string) =>
    request<{ ok: boolean; smsSent: boolean }>("/api/admin/board/cancel", {
      method: "POST",
      admin: true,
      body: { workerId, date, clientId },
    }),
  nudgeCell: (workerId: string, date: string) =>
    request<{ ok: boolean; nudged: string }>("/api/admin/board/nudge", {
      method: "POST",
      admin: true,
      body: { workerId, date },
    }),

  // ---- Shift templates ----
  templates: (clientId: string) =>
    request<ShiftTemplate[]>(`/api/admin/clients/${clientId}/templates`, { admin: true }),
  createTemplate: (clientId: string, data: { name: string; startTime: string; endTime: string }) =>
    request<ShiftTemplate>(`/api/admin/clients/${clientId}/templates`, {
      method: "POST",
      admin: true,
      body: data,
    }),
  deleteTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/templates/${id}`, { method: "DELETE", admin: true }),
};
