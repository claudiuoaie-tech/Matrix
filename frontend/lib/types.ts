// Shared types mirroring the Express + Prisma API responses.

export type ClientPool = "POOL_A" | "POOL_B" | "POOL_C";
export type WorkerStatus = "ACTIVE" | "SUSPENDED" | "INACTIVE";
export type ShiftSlot = "AM" | "PM" | "NIGHT";
export type AllocationState =
  | "AVAILABLE"
  | "PROPOSED"
  | "CONFIRMED"
  | "DECLINED"
  | "TIMEOUT";
export type HolidayStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface WorkerProfile {
  id: string;
  name: string;
  phone: string;
  status: WorkerStatus;
  clientPool: ClientPool;
  // Preferred outbound channel for automated messaging (SMS default; WhatsApp for
  // international workers). Admin-overridable from the worker profile.
  preferredChannel?: MessageChannel;
  rtwExpiryDate?: string | null;
  skills?: string[];
  email?: string | null;
}

export interface ImportSummary {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  expiredFlagged: number;
  errors: { row: number; reason: string }[];
  message: string;
}

export type DocType = "PASSPORT" | "RTW" | "PROOF_OF_ADDRESS" | "OTHER";

export interface WorkerDocument {
  id: string;
  workerId: string;
  docType: DocType;
  fileName: string;
  filePath: string;
  mimeType: string;
  uploadedAt: string;
}

export interface AvailabilityCell {
  dayOfWeek: number; // 0 = Monday .. 6 = Sunday
  slot: ShiftSlot;
  available: boolean;
}

export interface ScheduleEntry {
  allocationId: string;
  state: AllocationState;
  shift: {
    id: string;
    date: string;
    slot: ShiftSlot;
    startTime: string;
    endTime: string;
    client: string;
  };
}

export type MessageChannel = "SMS" | "WHATSAPP";

export type MessageDirection = "INBOUND" | "OUTBOUND";

export interface IncomingMessage {
  id: string;
  fromNumber: string;
  messageBody: string;
  channel: MessageChannel;
  direction: MessageDirection;
  mediaUrl: string | null;
  receivedAt: string;
  isRead: boolean;
  workerName: string | null;
}

export interface InboxResponse {
  unread: number;
  messages: IncomingMessage[];
  // phone → ISO expiry for WhatsApp contacts still inside their 24h window.
  windows?: Record<string, string>;
}

/** One editable positional variable in a WhatsApp template. */
export interface TemplateVariable {
  position: string; // "1".."N"
  label: string;
  sample: string;
  // "worker_name" → personalised per recipient from the matched worker in a bulk
  // send; the typed value is only a fallback for unmatched manual numbers.
  source?: "worker_name";
}

/** An approved WhatsApp (Meta) template available for out-of-session sends. */
export interface MessageTemplate {
  key: string;
  displayName: string;
  variables: TemplateVariable[];
}

/** Per-recipient outcome of a bulk dispatch. */
export interface BulkResultRow {
  phone: string;
  ok: boolean;
  code?: string | number;
  error?: string;
}

/** Response from a bulk send: counts, per-number results, and logged rows. */
export interface BulkSendResponse {
  ok: boolean;
  sent: number;
  failed: number;
  results: BulkResultRow[];
  messages: IncomingMessage[];
}

/** An outbound attachment uploaded/pasted by an admin (base64 data URL). */
export interface OutboundMedia {
  fileName: string;
  mimeType: string;
  data: string;
}

export interface WorkerShift {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string | null;
  endTime: string | null;
  label: string | null; // shift name / section
  client: string | null; // client/company name
}

export interface HolidayRequest {
  id: string;
  workerId: string;
  startDate: string;
  endDate: string;
  status: HolidayStatus;
  note: string | null;
}

export interface RotaAllocation {
  id: string;
  state: AllocationState;
  workerId: string;
  workerName: string;
}

export interface RotaShift {
  id: string;
  date: string;
  slot: ShiftSlot;
  startTime: string;
  endTime: string;
  slotsNeeded: number;
  confirmedCount: number;
  fulfilment: string;
  allocations: RotaAllocation[];
}

export interface RotaClient {
  id: string;
  companyName: string;
  address: string;
  shifts: RotaShift[];
}

export interface RotaResponse {
  weekStart: string;
  clients: RotaClient[];
}

export interface AdminWorker extends WorkerProfile {
  _count: { allocations: number; holidays: number; documents: number };
}

export interface RecipientCandidate {
  id: string;
  name: string;
  phone: string;
  clientPool: ClientPool;
  allocatedForDate: boolean;
}

// ---- Planning board --------------------------------------------------------

export type RotaStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "SICK"
  | "REST"
  | "HOLIDAY"
  | "SCHEDULED"
  | "CANCELLED"
  | "NO_SHOW"
  | "REJECTED";

export interface ClientLite {
  id: string;
  companyName: string;
  address: string;
  pool: ClientPool;
  // Present from GET /api/admin/clients (Phase 4); omitted by lighter callers.
  phone?: string | null;
  workerCount?: number;
}

export interface BoardCell {
  id: string;
  status: RotaStatus;
  confirmed: boolean;
  label: string | null;
  startTime: string | null;
  endTime: string | null;
  clientId: string | null;
}

export interface BoardWorker {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  clientPool: ClientPool;
  status: WorkerStatus;
  skills: string[];
  cells: Record<string, BoardCell>; // keyed by YYYY-MM-DD
}

export interface BoardResponse {
  startDate: string;
  days: string[]; // 14 YYYY-MM-DD keys
  client: { id: string; companyName: string; pool: ClientPool } | null;
  workers: BoardWorker[];
}

export interface ShiftTemplate {
  id: string;
  clientId: string;
  name: string;
  startTime: string;
  endTime: string;
}

export interface WorkerBoardResponse {
  startDate: string;
  days: string[];
  cells: Record<string, { status: RotaStatus; startTime: string | null; label: string | null }>;
}

export interface RotaEvent {
  type:
    | "allocation.updated"
    | "allocation.created"
    | "worker.updated"
    | "broadcast.sent"
    | "availability.updated"
    | "holiday.created"
    | "board.updated"
    | "message.received";
  payload: Record<string, unknown>;
}
