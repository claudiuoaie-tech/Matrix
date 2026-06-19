"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Sliders,
  Copy,
  ClipboardPaste,
  X,
  Ban,
  Trash2,
  Clock,
  AlertTriangle,
  Bell,
  Users,
  MessageSquare,
  Send,
  CheckSquare,
  Square,
  CalendarRange,
  CalendarDays,
  ListChecks,
  Eraser,
  Filter,
  FilterX,
  ArrowDownAZ,
  ArrowUpAZ,
  Search,
  CheckCheck,
} from "lucide-react";
import { admin, CellInput } from "@/lib/api";
import type {
  BoardResponse,
  BoardCell,
  BoardWorker,
  ClientLite,
  RotaEvent,
  RotaStatus,
  ShiftTemplate,
} from "@/lib/types";
import {
  STATUS_STYLES,
  ADMIN_STATUSES,
  dateLabel,
  dayLabel,
  isWeekend,
  longDayLabel,
  cellText,
} from "@/lib/boardUi";
import TemplatesModal from "./TemplatesModal";

// Wider, more relaxed day columns: each day = a status sub-column + an action
// sub-column, summing to ~188px so labels and the utility icons never wrap.
const NAME_W = 220;
const STATUS_W = 116;
const ACTION_W = 72;
const HEADER_H = 34;

// Frozen-pane shadow on the right edge of the sticky name columns.
const STICKY_SHADOW = "6px 0 10px -6px rgba(15,23,42,0.18)";

// Pre-configured Twilio text templates for the grid-level broadcast.
const SMS_TEMPLATES: { id: string; label: string; body: string }[] = [
  {
    id: "urgent",
    label: "Urgent Shift Fill Request",
    body:
      "Urgent: we need cover for an upcoming shift. Are you free? Reply 1 to accept or 2 to decline.",
  },
  {
    id: "reminder",
    label: "Availability Reminder Inquiry",
    body:
      "Quick reminder: please update your availability for the coming week so we can book you in.",
  },
  {
    id: "confirm",
    label: "Confirm Availability",
    body:
      "Can you confirm your availability for shifts this week? Reply 1 if you're available, 2 if not.",
  },
];

// Statuses offered in the bulk-action dropdown (SCHEDULED first, then the rest).
const BULK_STATUSES: RotaStatus[] = ["SCHEDULED", ...ADMIN_STATUSES];

// A status set never texts the worker (matches the backend's silent list).
const SILENT_STATUSES: RotaStatus[] = ["AVAILABLE", "UNAVAILABLE"];

interface BulkConfirm {
  kind: "set" | "clear";
  status?: RotaStatus;
  label?: string | null;
  startTime?: string | null;
}

interface EditorTarget {
  workerId: string;
  workerName: string;
  date: string;
  cell: BoardCell | null;
  rect: { left: number; top: number; bottom: number };
}

interface Clipboard {
  status: RotaStatus;
  label: string | null;
  startTime: string | null;
  endTime: string | null;
}

const selKey = (workerId: string, date: string) => `${workerId}|${date}`;
const isSelectable = (cell: BoardCell | null) => !cell || cell.status === "AVAILABLE";

// ---- Excel-style per-column sort / filter helpers --------------------------
//
// Each day column can be independently sorted and filtered on the value of its
// own cell. A cell is reduced to a canonical "token" so the same shift time or
// status groups together across workers; the row matrix is then reordered /
// filtered purely by mapping board.workers -> a derived array, which keeps the
// frozen name column perfectly in sync (names and cells come from one object).

const BLANK_TOKEN = "__BLANK__";

// Non-working statuses, collected under the "Unavailable" footer metric. REJECTED
// (worker declined the SMS offer) is included so every cell maps to exactly one
// of the three buckets (Allocated / Unallocated / Unavailable).
const NON_WORKING: RotaStatus[] = [
  "UNAVAILABLE",
  "SICK",
  "REST",
  "HOLIDAY",
  "CANCELLED",
  "NO_SHOW",
  "REJECTED",
];

/** Canonical filter/group token for a cell on a given day. */
function cellToken(cell: BoardCell | null): string {
  if (!cell) return BLANK_TOKEN;
  if (cell.status === "SCHEDULED") {
    if (cell.startTime) return `time:${cell.startTime}`;
    if (cell.label) return `label:${cell.label}`;
    return "status:SCHEDULED";
  }
  return `status:${cell.status}`;
}

/** Human-readable label for a token (used in the checkbox list). */
function tokenLabel(token: string): string {
  if (token === BLANK_TOKEN) return "(Blanks)";
  if (token.startsWith("time:")) return token.slice(5);
  if (token.startsWith("label:")) return token.slice(6);
  if (token.startsWith("status:")) {
    const s = token.slice(7) as RotaStatus;
    return STATUS_STYLES[s]?.label ?? s;
  }
  return token;
}

/** "HH:MM" -> minutes; null/blank sorts last. */
function timeToMin(t: string | null): number {
  if (!t) return Number.POSITIVE_INFINITY;
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Stable ordering rank for tokens in the checkbox list: times, labels, statuses, blanks. */
function tokenRank(t: string): number {
  if (t === BLANK_TOKEN) return 3;
  if (t.startsWith("time:")) return 0;
  if (t.startsWith("label:")) return 1;
  return 2;
}
function tokenSortCompare(a: string, b: string): number {
  const ra = tokenRank(a);
  const rb = tokenRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return timeToMin(a.slice(5)) - timeToMin(b.slice(5));
  return tokenLabel(a).localeCompare(tokenLabel(b));
}

interface SortKey {
  blank: boolean;
  group: number; // 0 = scheduled shift, 1 = other status
  time: number;
  text: string;
}
function cellSortKey(cell: BoardCell | null): SortKey {
  if (!cell) return { blank: true, group: 9, time: Number.POSITIVE_INFINITY, text: "" };
  if (cell.status === "SCHEDULED") {
    return { blank: false, group: 0, time: timeToMin(cell.startTime), text: cell.label ?? "" };
  }
  return {
    blank: false,
    group: 1,
    time: Number.POSITIVE_INFINITY,
    text: STATUS_STYLES[cell.status].label,
  };
}

/**
 * Compare two cells for a column sort. Scheduled shifts (ordered by start time)
 * group above other statuses; blanks always sink to the bottom regardless of
 * direction; only the within-group order flips for descending.
 */
function compareCells(a: BoardCell | null, b: BoardCell | null, dir: "asc" | "desc"): number {
  const ka = cellSortKey(a);
  const kb = cellSortKey(b);
  if (ka.blank !== kb.blank) return ka.blank ? 1 : -1;
  if (ka.blank) return 0;
  if (ka.group !== kb.group) return ka.group - kb.group;
  let r = ka.time - kb.time;
  if (r === 0) r = ka.text.localeCompare(kb.text);
  return dir === "asc" ? r : -r;
}

export default function BoardGrid({ lastEvent }: { lastEvent: RotaEvent | null }) {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [clientId, setClientId] = useState<string>("");
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<EditorTarget | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [nudging, setNudging] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // View filter: current week (7 days) vs. full fortnight (14 days).
  const [view, setView] = useState<"week" | "fortnight">("week");

  // Grid-level SMS broadcast.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetDate, setTargetDate] = useState<string>("");
  const [smsOpen, setSmsOpen] = useState(false);

  // Bulk multi-select (cell-based) status actions. Each key is `workerId|date`.
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkCells, setBulkCells] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<RotaStatus | "">("");
  const [bulkTime, setBulkTime] = useState<string>("");
  const [bulkLabel, setBulkLabel] = useState<string>("");
  const [bulkSilent, setBulkSilent] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Click-and-drag selection across cells (works in Quick Match and Bulk modes).
  const dragRef = useRef<{ active: boolean; add: boolean; mode: "select" | "bulk" } | null>(null);

  // Excel-style per-column sort/filter. `filters` is keyed by day; a present key
  // means that column is filtered to the contained token set (compound/AND across
  // columns). `sort` is a single active column sort (like Excel). `filterMenu`
  // tracks the open dropdown and its anchor rect.
  const [filters, setFilters] = useState<Record<string, Set<string>>>({});
  const [sort, setSort] = useState<{ date: string; dir: "asc" | "desc" } | null>(null);

  // Skills filter: free-text; multiple whitespace/comma-separated terms must each
  // match one of the worker's skills (AND), so "Driver Forklift" finds workers
  // holding both.
  const [skillQuery, setSkillQuery] = useState("");

  // Summary-footer metric filter: isolates the board to just the Pending or
  // Unavailable workers for one specific day (driven by the footer click).
  const [footerFilter, setFooterFilter] = useState<{
    date: string;
    kind: "pending" | "unavailable";
  } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{
    date: string;
    rect: { left: number; bottom: number; right: number };
  } | null>(null);

  const flashMsg = useCallback((m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2200);
  }, []);

  useEffect(() => {
    admin.clients().then((list) => {
      setClients(list);
      if (list.length) setClientId((cur) => cur || list[0].id);
    });
  }, []);

  const loadBoard = useCallback(() => {
    admin.board(clientId || undefined).then(setBoard).finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    setLoading(true);
    loadBoard();
    admin.templates(clientId).then(setTemplates);
    // Switching client resets any in-progress selection.
    setSelected(new Set());
    setSelectMode(false);
    setSmsOpen(false);
    setBulkCells(new Set());
    setBulkMode(false);
    setBulkConfirm(null);
    setFilters({});
    setSort(null);
    setFilterMenu(null);
    setSkillQuery("");
    setFooterFilter(null);
  }, [clientId, loadBoard]);

  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === "board.updated" || lastEvent.type === "allocation.updated") {
      loadBoard();
    }
  }, [lastEvent, loadBoard]);

  // End any in-progress drag-selection when the mouse is released anywhere.
  useEffect(() => {
    const up = () => {
      if (dragRef.current) dragRef.current.active = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const visibleDays = useMemo(() => {
    if (!board) return [];
    return view === "week" ? board.days.slice(0, 7) : board.days;
  }, [board, view]);

  // The actual row order shown: board.workers filtered by every active column
  // filter (compound AND), then reordered by the single active column sort. The
  // name column reads from the SAME worker object per row, so it stays in sync.
  const displayWorkers = useMemo<BoardWorker[]>(() => {
    if (!board) return [];
    let rows = board.workers;
    const terms = skillQuery
      .toLowerCase()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length) {
      rows = rows.filter((w) =>
        terms.every((t) => w.skills.some((s) => s.toLowerCase().includes(t)))
      );
    }
    const activeFilters = Object.entries(filters);
    if (activeFilters.length) {
      rows = rows.filter((w) =>
        activeFilters.every(([date, allowed]) => allowed.has(cellToken(w.cells[date] ?? null)))
      );
    }
    // Summary-footer metric filter (Pending / Unavailable for one day).
    if (footerFilter) {
      const { date, kind } = footerFilter;
      rows = rows.filter((w) => {
        const c = w.cells[date] ?? null;
        if (kind === "pending") return c?.status === "SCHEDULED" && !c.confirmed;
        return !!c && NON_WORKING.includes(c.status);
      });
    }
    if (sort) {
      rows = [...rows].sort((a, b) => {
        const c = compareCells(a.cells[sort.date] ?? null, b.cells[sort.date] ?? null, sort.dir);
        return c !== 0 ? c : a.name.localeCompare(b.name);
      });
    }
    return rows;
  }, [board, filters, sort, skillQuery, footerFilter]);

  // Per-day tallies for the summary footer, computed across the full client pool
  // (stable totals, independent of the view filters above).
  const columnStats = useMemo(() => {
    const map: Record<
      string,
      {
        allocated: number;
        confirmed: number;
        pending: number;
        unallocated: number;
        unavailable: number;
        unallocatedIds: string[];
      }
    > = {};
    if (!board) return map;
    for (const d of visibleDays) {
      let allocated = 0;
      let confirmed = 0;
      let pending = 0;
      let unallocated = 0;
      let unavailable = 0;
      const unallocatedIds: string[] = [];
      for (const w of board.workers) {
        const c = w.cells[d] ?? null;
        if (!c || c.status === "AVAILABLE") {
          unallocated++;
          unallocatedIds.push(w.id);
        } else if (c.status === "SCHEDULED") {
          allocated++;
          if (c.confirmed) confirmed++;
          else pending++;
        } else {
          unavailable++;
        }
      }
      map[d] = { allocated, confirmed, pending, unallocated, unavailable, unallocatedIds };
    }
    return map;
  }, [board, visibleDays]);

  const hasColumnControls =
    Object.keys(filters).length > 0 || sort !== null || footerFilter !== null;
  const isColActive = (date: string) => !!filters[date] || sort?.date === date;

  // Toggle a summary-footer metric filter; clicking the active one clears it.
  function toggleFooterFilter(date: string, kind: "pending" | "unavailable") {
    setFooterFilter((cur) =>
      cur && cur.date === date && cur.kind === kind ? null : { date, kind }
    );
  }

  // Smart Nudge: open the broadcast drawer pre-filled with this day's unallocated workers.
  function nudgeUnallocated(date: string) {
    const ids = columnStats[date]?.unallocatedIds ?? [];
    if (!ids.length) return;
    exitBulkMode();
    setSelectMode(true);
    setTargetDate(date);
    setSelected(new Set(ids.map((id) => selKey(id, date))));
    setSmsOpen(true);
  }

  function openFilterMenu(e: React.MouseEvent, date: string) {
    e.stopPropagation();
    if (filterMenu?.date === date) {
      setFilterMenu(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFilterMenu({ date, rect: { left: r.left, bottom: r.bottom, right: r.right } });
  }

  function applyColumnFilter(date: string, set: Set<string> | null) {
    setFilters((prev) => {
      const next = { ...prev };
      if (set === null) delete next[date];
      else next[date] = set;
      return next;
    });
  }

  function setColumnSort(date: string, dir: "asc" | "desc") {
    setSort({ date, dir });
  }

  function clearColumn(date: string) {
    setFilters((prev) => {
      if (!prev[date]) return prev;
      const next = { ...prev };
      delete next[date];
      return next;
    });
    setSort((cur) => (cur?.date === date ? null : cur));
  }

  function clearAllColumnControls() {
    setFilters({});
    setSort(null);
    setFilterMenu(null);
    setFooterFilter(null);
  }

  // Keep the quick-select target date pointed at a visible day.
  useEffect(() => {
    if (!visibleDays.length) return;
    setTargetDate((cur) => (cur && visibleDays.includes(cur) ? cur : visibleDays[0]));
  }, [visibleDays]);

  async function applyCell(
    workerId: string,
    date: string,
    input: Partial<CellInput>,
    silent = false
  ) {
    const res = await admin.setCell(
      {
        workerId,
        date,
        status: input.status!,
        label: input.label ?? null,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        clientId: input.clientId ?? clientId ?? null,
      },
      silent
    );
    setEditor(null);
    loadBoard();
    if (res?.smsSent) flashMsg("Status updated — worker texted");
    else if (silent) flashMsg("Status updated silently — no text sent");
  }

  async function clearCell(workerId: string, date: string) {
    await admin.clearCell(workerId, date);
    setEditor(null);
    loadBoard();
  }

  function handleCellClick(
    e: React.MouseEvent,
    workerId: string,
    workerName: string,
    date: string,
    cell: BoardCell | null
  ) {
    // In Quick Match / Bulk modes selection is driven by mouse down + drag
    // (see onCellMouseDown / onCellMouseEnter), so the click is a no-op here.
    if (selectMode || bulkMode) return;
    if (pasteMode && clipboard) {
      void admin
        .setCell({
          workerId,
          date,
          status: clipboard.status,
          label: clipboard.label,
          startTime: clipboard.startTime,
          endTime: clipboard.endTime,
          clientId: clientId || null,
        })
        .then(() => loadBoard());
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setEditor({
      workerId,
      workerName,
      date,
      cell,
      rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
  }

  // Add/remove a single cell from the active mode's selection.
  function applySelection(
    workerId: string,
    date: string,
    cell: BoardCell | null,
    add: boolean,
    mode: "select" | "bulk"
  ) {
    if (mode === "select" && !isSelectable(cell)) return;
    const setFn = mode === "bulk" ? setBulkCells : setSelected;
    setFn((prev) => {
      const next = new Set(prev);
      const k = selKey(workerId, date);
      if (add) next.add(k);
      else next.delete(k);
      return next;
    });
  }

  // Start a drag: the first cell decides whether we're selecting or deselecting.
  function onCellMouseDown(
    e: React.MouseEvent,
    workerId: string,
    date: string,
    cell: BoardCell | null
  ) {
    const mode: "select" | "bulk" | null = bulkMode ? "bulk" : selectMode ? "select" : null;
    if (!mode) return;
    if (mode === "select" && !isSelectable(cell)) return;
    e.preventDefault(); // don't start a native text selection
    const k = selKey(workerId, date);
    const currently = (mode === "bulk" ? bulkCells : selected).has(k);
    const add = !currently;
    dragRef.current = { active: true, add, mode };
    applySelection(workerId, date, cell, add, mode);
  }

  // Extend the drag over any cell the pointer enters.
  function onCellMouseEnter(workerId: string, date: string, cell: BoardCell | null) {
    const st = dragRef.current;
    if (!st?.active) return;
    applySelection(workerId, date, cell, st.add, st.mode);
  }

  function selectByStatus(kind: "available" | "unmarked") {
    if (!board || !targetDate) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const w of displayWorkers) {
        const cell = w.cells[targetDate] ?? null;
        const match =
          kind === "available" ? cell?.status === "AVAILABLE" : cell == null;
        if (match) next.add(selKey(w.id, targetDate));
      }
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
    setSmsOpen(false);
  }

  async function nudge(workerId: string, date: string, name: string) {
    const key = selKey(workerId, date);
    setNudging(key);
    try {
      await admin.nudgeCell(workerId, date);
      flashMsg(`Nudged ${name.split(" ")[0]} by text`);
    } finally {
      setNudging(null);
    }
  }

  function copyCell(cell: BoardCell) {
    setClipboard({
      status: cell.status,
      label: cell.label,
      startTime: cell.startTime,
      endTime: cell.endTime,
    });
    flashMsg("Copied — turn on paste mode to apply");
  }

  const selectedClient = clients.find((c) => c.id === clientId);

  // Unique workers across the selected cells (dedupe by worker for sending).
  const selectedWorkerIds = useMemo(
    () => Array.from(new Set(Array.from(selected).map((k) => k.split("|")[0]))),
    [selected]
  );
  const selectedWorkers = useMemo(
    () => (board ? board.workers.filter((w) => selectedWorkerIds.includes(w.id)) : []),
    [board, selectedWorkerIds]
  );

  async function sendQuickSms(body: string) {
    await admin.broadcast(body, selectedWorkerIds);
    const count = selectedWorkerIds.length;
    exitSelectMode();
    flashMsg(`Quick Match SMS sent to ${count} worker${count === 1 ? "" : "s"}`);
  }

  // ---- Bulk multi-select (cell-based) ---------------------------------------

  function enterBulkMode() {
    exitSelectMode();
    setBulkMode(true);
  }

  function exitBulkMode() {
    setBulkMode(false);
    setBulkCells(new Set());
    setBulkConfirm(null);
  }

  // Select-all helpers for a whole column (one day), a whole row (one worker),
  // and the entire grid.
  function columnAllSelected(date: string): boolean {
    return (
      displayWorkers.length > 0 && displayWorkers.every((w) => bulkCells.has(selKey(w.id, date)))
    );
  }
  function toggleBulkColumn(date: string) {
    setBulkCells((prev) => {
      const next = new Set(prev);
      const all = displayWorkers.every((w) => next.has(selKey(w.id, date)));
      for (const w of displayWorkers) {
        const k = selKey(w.id, date);
        if (all) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  function rowAllSelected(workerId: string): boolean {
    return visibleDays.length > 0 && visibleDays.every((d) => bulkCells.has(selKey(workerId, d)));
  }
  function toggleBulkRowCells(workerId: string) {
    setBulkCells((prev) => {
      const next = new Set(prev);
      const all = visibleDays.every((d) => next.has(selKey(workerId, d)));
      for (const d of visibleDays) {
        const k = selKey(workerId, d);
        if (all) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  const allCellsSelected =
    displayWorkers.length > 0 &&
    visibleDays.length > 0 &&
    displayWorkers.every((w) => visibleDays.every((d) => bulkCells.has(selKey(w.id, d))));
  function toggleAllCells() {
    if (allCellsSelected) {
      setBulkCells(new Set());
    } else {
      const next = new Set<string>();
      for (const w of displayWorkers) for (const d of visibleDays) next.add(selKey(w.id, d));
      setBulkCells(next);
    }
  }

  // How many texts a pending bulk action would fire (for the confirm summary).
  function bulkSmsCount(c: BulkConfirm): number {
    if (bulkSilent) return 0;
    if (c.kind === "clear" || !c.status) return 0;
    if (SILENT_STATUSES.includes(c.status)) return 0;
    return bulkCells.size;
  }

  function requestBulkSet() {
    if (!bulkStatus || bulkCells.size === 0) return;
    if (bulkStatus === "SCHEDULED" && !bulkTime && !bulkLabel.trim()) {
      flashMsg("Enter a shift name or start time for scheduled shifts");
      return;
    }
    setBulkConfirm({
      kind: "set",
      status: bulkStatus,
      label: bulkStatus === "SCHEDULED" ? bulkLabel.trim() || null : null,
      startTime: bulkStatus === "SCHEDULED" ? bulkTime || null : null,
    });
  }

  function requestBulkClear() {
    if (bulkCells.size === 0) return;
    setBulkConfirm({ kind: "clear" });
  }

  async function executeBulk() {
    if (!bulkConfirm || bulkCells.size === 0) return;
    setBulkBusy(true);
    const keys = Array.from(bulkCells).map((k) => {
      const [workerId, date] = k.split("|");
      return { workerId, date };
    });
    try {
      if (bulkConfirm.kind === "clear") {
        await Promise.all(keys.map(({ workerId, date }) => admin.clearCell(workerId, date)));
        flashMsg(`Cleared ${keys.length} cell${keys.length === 1 ? "" : "s"}`);
      } else {
        const status = bulkConfirm.status!;
        const cells: CellInput[] = keys.map(({ workerId, date }) => ({
          workerId,
          date,
          status,
          label: bulkConfirm.label ?? null,
          startTime: bulkConfirm.startTime ?? null,
          endTime: null,
          clientId: clientId || null,
        }));
        const res = await admin.setCells(cells, bulkSilent);
        flashMsg(
          `Updated ${res.count} cell${res.count === 1 ? "" : "s"} — ${res.smsSent} text${
            res.smsSent === 1 ? "" : "s"
          } sent`
        );
      }
      setBulkConfirm(null);
      setBulkCells(new Set());
      loadBoard();
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/70 bg-white p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-slate-400" />
          <span className="text-sm font-medium text-slate-500">Client / site</span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm font-semibold tracking-tight text-slate-700 outline-none transition-all duration-200 hover:bg-slate-50 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName}
              </option>
            ))}
          </select>
        </div>

        {/* View filter: week vs fortnight */}
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50/60 p-0.5">
          <button
            onClick={() => setView("week")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
              view === "week"
                ? "bg-white text-indigo-600 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <CalendarDays size={15} /> Current week
          </button>
          <button
            onClick={() => setView("fortnight")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
              view === "fortnight"
                ? "bg-white text-indigo-600 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <CalendarRange size={15} /> Full fortnight
          </button>
        </div>

        <button
          onClick={() => setShowTemplates(true)}
          disabled={!clientId}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 shadow-sm transition-all duration-200 hover:bg-indigo-50/50 hover:text-indigo-600 disabled:opacity-50"
        >
          <Sliders size={15} /> Shift patterns
        </button>

        {/* Skills filter */}
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={skillQuery}
            onChange={(e) => setSkillQuery(e.target.value)}
            placeholder="Filter by skill…"
            className="w-44 rounded-xl border border-slate-200 bg-slate-50/60 py-2 pl-8 pr-7 text-sm text-slate-700 outline-none transition-all duration-200 hover:bg-slate-50 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
          {skillQuery && (
            <button
              onClick={() => setSkillQuery("")}
              title="Clear skill filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Quick Match SMS toggle */}
        <button
          onClick={() => {
            if (selectMode) exitSelectMode();
            else {
              exitBulkMode();
              setSelectMode(true);
            }
          }}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold tracking-tight shadow-sm transition-all duration-200 ${
            selectMode
              ? "bg-indigo-600 text-white hover:bg-indigo-700"
              : "border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          }`}
        >
          <MessageSquare size={15} /> {selectMode ? "Exit match mode" : "Quick Match SMS"}
        </button>

        {/* Bulk edit toggle */}
        <button
          onClick={() => (bulkMode ? exitBulkMode() : enterBulkMode())}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold tracking-tight shadow-sm transition-all duration-200 ${
            bulkMode
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          }`}
        >
          <ListChecks size={15} /> {bulkMode ? "Exit bulk edit" : "Bulk edit"}
        </button>

        {hasColumnControls && (
          <button
            onClick={clearAllColumnControls}
            title="Reset every column's sort and filter"
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold tracking-tight text-amber-700 shadow-sm transition-all duration-200 hover:bg-amber-100"
          >
            <FilterX size={15} /> Clear column filters
          </button>
        )}

        {pasteMode && clipboard ? (
          <span className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700">
            <ClipboardPaste size={15} />
            Paste: {cellText(clipboard.status, clipboard.startTime, clipboard.label)} — click cells
            <button onClick={() => setPasteMode(false)} className="text-indigo-400 hover:text-indigo-700">
              <X size={15} />
            </button>
          </span>
        ) : (
          clipboard && (
            <span className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-sm">
              <Copy size={14} /> {cellText(clipboard.status, clipboard.startTime, clipboard.label)}
              <button
                onClick={() => setPasteMode(true)}
                className="font-semibold text-indigo-600 hover:underline"
              >
                Paste…
              </button>
            </span>
          )
        )}

        <span className="ml-auto text-xs font-medium tracking-tight text-slate-400">
          {visibleDays.length
            ? `${dateLabel(visibleDays[0])} – ${dateLabel(
                visibleDays[visibleDays.length - 1]
              )} · ${visibleDays.length} days`
            : ""}
        </span>
      </div>

      {/* Selection sub-toolbar (Quick Match mode) */}
      {selectMode && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-200/70 bg-indigo-50/40 p-3 shadow-sm">
          <span className="text-sm font-semibold tracking-tight text-indigo-700">
            Match workers — pick AVAILABLE or blank cells
          </span>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500">For day</span>
            <select
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            >
              {visibleDays.map((d) => (
                <option key={d} value={d}>
                  {longDayLabel(d)}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => selectByStatus("available")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm transition-all hover:bg-white hover:text-indigo-600"
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: STATUS_STYLES.AVAILABLE.bg }}
            />
            Select all available
          </button>
          <button
            onClick={() => selectByStatus("unmarked")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm transition-all hover:bg-white hover:text-indigo-600"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-slate-300 bg-slate-50" />
            Select all unmarked
          </button>

          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm font-medium text-slate-400 hover:text-slate-600"
            >
              Clear
            </button>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm font-medium text-slate-500">
              {selectedWorkerIds.length} worker
              {selectedWorkerIds.length === 1 ? "" : "s"} selected
            </span>
            <button
              onClick={() => setSmsOpen(true)}
              disabled={selectedWorkerIds.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold tracking-tight text-white shadow-sm transition-all duration-200 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Send size={15} /> Compose SMS
            </button>
          </div>
        </div>
      )}

      {/* Grid panel */}
      {loading || !board ? (
        <div className="grid place-items-center rounded-2xl border border-slate-200/70 bg-white py-24 shadow-sm">
          <Loader2 className="animate-spin text-slate-300" />
        </div>
      ) : board.workers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm text-slate-400 shadow-sm">
          No workers in this client&apos;s pool.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm">
          <div
            className={`scrollbar-thin overflow-auto ${
              selectMode || bulkMode ? "select-none" : ""
            }`}
            style={{ maxHeight: "68vh" }}
          >
            <table className="border-separate" style={{ borderSpacing: 0 }}>
              <colgroup>
                <col style={{ width: NAME_W }} />
                {visibleDays.map((d) => (
                  <Fragment2 key={d}>
                    <col style={{ width: STATUS_W }} />
                    <col style={{ width: ACTION_W }} />
                  </Fragment2>
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th
                    rowSpan={2}
                    className="bg-slate-50/90 text-left align-bottom backdrop-blur"
                    style={{
                      position: "sticky",
                      left: 0,
                      top: 0,
                      zIndex: 40,
                      width: NAME_W,
                      padding: "8px 14px",
                      borderRight: "1px solid #e2e8f0",
                      borderBottom: "1px solid #e2e8f0",
                      boxShadow: STICKY_SHADOW,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {bulkMode && (
                        <button
                          onClick={toggleAllCells}
                          title={allCellsSelected ? "Deselect everything" : "Select every cell"}
                          className="grid place-items-center text-emerald-600 hover:text-emerald-700"
                        >
                          {allCellsSelected ? (
                            <CheckSquare size={17} />
                          ) : (
                            <Square size={17} className="text-slate-300" />
                          )}
                        </button>
                      )}
                      <span className="text-base font-semibold tracking-tight text-slate-700">
                        Name
                      </span>
                    </div>
                  </th>
                  {visibleDays.map((d) => (
                    <th
                      key={d}
                      colSpan={2}
                      className={`text-center font-semibold tracking-tight ${
                        isWeekend(d) ? "text-slate-400" : "text-slate-600"
                      }`}
                      style={{
                        position: "sticky",
                        top: 0,
                        zIndex: 30,
                        height: HEADER_H,
                        fontSize: 12.5,
                        background: isWeekend(d) ? "#f1f5f9e6" : "#f8fafce6",
                        borderRight: "1px solid #e2e8f0",
                        borderBottom: "1px solid #eef2f7",
                      }}
                    >
                      {dateLabel(d)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {visibleDays.map((d) => (
                    <th
                      key={d}
                      colSpan={2}
                      className="font-medium uppercase tracking-wide text-slate-400"
                      style={{
                        position: "sticky",
                        top: HEADER_H,
                        zIndex: 30,
                        height: HEADER_H - 8,
                        fontSize: 10,
                        background: isWeekend(d) ? "#f1f5f9e6" : "#f8fafce6",
                        borderRight: "1px solid #e2e8f0",
                        borderBottom: "1px solid #e2e8f0",
                      }}
                    >
                      <div className="flex items-center justify-center gap-1.5">
                        {bulkMode && (
                          <button
                            onClick={() => toggleBulkColumn(d)}
                            title={columnAllSelected(d) ? "Deselect this day" : "Select whole day"}
                            className="grid place-items-center text-emerald-600 hover:text-emerald-700"
                          >
                            {columnAllSelected(d) ? (
                              <CheckSquare size={13} />
                            ) : (
                              <Square size={13} className="text-slate-300" />
                            )}
                          </button>
                        )}
                        {dayLabel(d)}
                        <button
                          onClick={(e) => openFilterMenu(e, d)}
                          title="Sort & filter this day"
                          className={`grid place-items-center rounded transition-colors ${
                            isColActive(d)
                              ? "text-indigo-600"
                              : "text-slate-300 hover:text-slate-500"
                          }`}
                        >
                          {sort?.date === d ? (
                            sort.dir === "asc" ? (
                              <ArrowUpAZ size={13} />
                            ) : (
                              <ArrowDownAZ size={13} />
                            )
                          ) : (
                            <Filter size={12} fill={filters[d] ? "currentColor" : "none"} />
                          )}
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayWorkers.length === 0 && (
                  <tr>
                    <td
                      colSpan={1 + visibleDays.length * 2}
                      className="bg-white px-6 py-10 text-center text-sm text-slate-400"
                    >
                      No workers match the active column filters.{" "}
                      <button
                        onClick={clearAllColumnControls}
                        className="font-semibold text-indigo-600 hover:underline"
                      >
                        Clear filters
                      </button>
                    </td>
                  </tr>
                )}
                {displayWorkers.map((w) => {
                  const rowChecked = bulkMode && rowAllSelected(w.id);
                  return (
                  <tr key={w.id} className="group">
                    <td
                      onClick={bulkMode ? () => toggleBulkRowCells(w.id) : undefined}
                      className={`truncate align-middle tracking-tight text-slate-700 transition-colors ${
                        bulkMode ? "cursor-pointer" : ""
                      } ${rowChecked ? "bg-emerald-50" : "bg-white group-hover:bg-slate-50/70"}`}
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 20,
                        width: NAME_W,
                        maxWidth: NAME_W,
                        padding: "8px 14px",
                        fontSize: 13,
                        borderRight: "1px solid #e2e8f0",
                        borderBottom: "1px solid #f1f5f9",
                        boxShadow: STICKY_SHADOW,
                      }}
                      title={w.name}
                    >
                      <div className="flex items-center gap-2">
                        {bulkMode && (
                          <span className="shrink-0">
                            {rowChecked ? (
                              <CheckSquare size={16} className="text-emerald-600" />
                            ) : (
                              <Square size={16} className="text-slate-300" />
                            )}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            <span className="font-semibold text-slate-700">{w.firstName}</span>{" "}
                            <span className="text-slate-500">{w.lastName}</span>
                          </span>
                          {w.skills.length > 0 && (
                            <span className="mt-0.5 flex flex-wrap gap-1">
                              {w.skills.slice(0, 3).map((s) => (
                                <span
                                  key={s}
                                  className="inline-flex items-center rounded border border-indigo-100 bg-indigo-50 px-1 py-px text-[9px] font-medium leading-tight text-indigo-600"
                                >
                                  {s}
                                </span>
                              ))}
                              {w.skills.length > 3 && (
                                <span
                                  className="inline-flex items-center rounded bg-slate-100 px-1 py-px text-[9px] font-medium leading-tight text-slate-500"
                                  title={w.skills.slice(3).join(", ")}
                                >
                                  +{w.skills.length - 3}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    {visibleDays.map((d) => {
                      const cell = w.cells[d] ?? null;
                      const key = selKey(w.id, d);
                      const active = editor?.workerId === w.id && editor?.date === d;
                      const quickChecked = selected.has(key);
                      const bulkChecked = bulkMode && bulkCells.has(key);
                      const selectable = selectMode && isSelectable(cell);
                      const showBox = selectMode || bulkMode;
                      const cellChecked = selectMode ? quickChecked : bulkChecked;
                      return (
                        <Fragment2 key={d}>
                          {/* Sub-column 1: status / shift (+ selection checkbox) */}
                          <td
                            onClick={(e) => handleCellClick(e, w.id, w.name, d, cell)}
                            onMouseDown={(e) => onCellMouseDown(e, w.id, d, cell)}
                            onMouseEnter={() => onCellMouseEnter(w.id, d, cell)}
                            className={`p-1.5 align-middle transition-all duration-200 ${
                              selectMode
                                ? selectable
                                  ? "cursor-pointer hover:bg-indigo-50/60"
                                  : "cursor-not-allowed"
                                : bulkMode
                                ? "cursor-pointer hover:bg-emerald-50/60"
                                : "cursor-pointer hover:bg-indigo-50/50"
                            }`}
                            style={{
                              height: 40,
                              background: bulkChecked
                                ? "#d1fae5"
                                : quickChecked
                                ? "#eef2ff"
                                : isWeekend(d) && !cell
                                ? "#fafbfc"
                                : undefined,
                              boxShadow: active
                                ? "inset 0 0 0 2px #6366f1"
                                : bulkChecked
                                ? "inset 0 0 0 1.5px #34d399"
                                : quickChecked
                                ? "inset 0 0 0 1.5px #818cf8"
                                : undefined,
                              borderBottom: "1px solid #f1f5f9",
                              opacity: selectMode && !selectable ? 0.45 : 1,
                            }}
                          >
                            <div className="flex items-center gap-1.5">
                              {showBox && (
                                <span className="shrink-0">
                                  {cellChecked ? (
                                    <CheckSquare
                                      size={15}
                                      className={bulkMode ? "text-emerald-600" : "text-indigo-600"}
                                    />
                                  ) : (
                                    <Square
                                      size={15}
                                      className={
                                        selectMode && !selectable ? "text-slate-200" : "text-slate-300"
                                      }
                                    />
                                  )}
                                </span>
                              )}
                              {cell ? (
                                <StatusBadge cell={cell} />
                              ) : (
                                <span
                                  className={`block flex-1 text-center text-[13px] leading-none ${
                                    showBox
                                      ? "text-slate-300"
                                      : "text-transparent group-hover:text-slate-300"
                                  } transition-colors`}
                                >
                                  {showBox ? "—" : "+"}
                                </span>
                              )}
                            </div>
                          </td>
                          {/* Sub-column 2: quick action */}
                          <td
                            className="align-middle text-center transition-colors group-hover:bg-slate-50/40"
                            style={{
                              borderRight: "1px solid #eef2f7",
                              borderBottom: "1px solid #f1f5f9",
                            }}
                          >
                            <ActionCell
                              status={cell?.status ?? null}
                              busy={nudging === selKey(w.id, d)}
                              hidden={selectMode || bulkMode}
                              onNudge={() => nudge(w.id, d, w.name)}
                              onCopy={() => cell && copyCell(cell)}
                            />
                          </td>
                        </Fragment2>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th
                    className="text-left align-top"
                    style={{
                      position: "sticky",
                      left: 0,
                      bottom: 0,
                      zIndex: 40,
                      width: NAME_W,
                      padding: "8px 14px",
                      background: "#f8fafc",
                      borderRight: "1px solid #e2e8f0",
                      borderTop: "2px solid #e2e8f0",
                      boxShadow: STICKY_SHADOW,
                    }}
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Day summary
                    </div>
                    <div className="mt-1.5 space-y-1 text-[10px] font-medium text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-green-600" /> Allocated
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-slate-400" /> Unallocated
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-rose-500" /> Unavailable
                      </div>
                    </div>
                  </th>
                  {visibleDays.map((d) => (
                    <th
                      key={d}
                      colSpan={2}
                      className="align-top"
                      style={{
                        position: "sticky",
                        bottom: 0,
                        zIndex: 30,
                        padding: 6,
                        background: isWeekend(d) ? "#f1f5f9" : "#f8fafc",
                        borderRight: "1px solid #e2e8f0",
                        borderTop: "2px solid #e2e8f0",
                      }}
                    >
                      <ColumnSummary
                        stats={
                          columnStats[d] ?? {
                            allocated: 0,
                            confirmed: 0,
                            pending: 0,
                            unallocated: 0,
                            unavailable: 0,
                            unallocatedIds: [],
                          }
                        }
                        pendingActive={
                          footerFilter?.date === d && footerFilter.kind === "pending"
                        }
                        unavailActive={
                          footerFilter?.date === d && footerFilter.kind === "unavailable"
                        }
                        onNudge={() => nudgeUnallocated(d)}
                        onTogglePending={() => toggleFooterFilter(d, "pending")}
                        onToggleUnavailable={() => toggleFooterFilter(d, "unavailable")}
                      />
                    </th>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-2xl border border-slate-200/70 bg-white px-4 py-3 text-xs font-medium text-slate-500 shadow-sm">
        {(Object.keys(STATUS_STYLES) as RotaStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-md border border-black/10"
              style={{ background: STATUS_STYLES[s].bg }}
            />
            {STATUS_STYLES[s].label}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 text-slate-400">
          <Bell size={12} /> Nudge · <Copy size={12} /> Copy
        </span>
      </div>

      {editor && !selectMode && !bulkMode && (
        <CellEditor
          target={editor}
          templates={templates}
          hasClipboard={!!clipboard}
          onClose={() => setEditor(null)}
          onStatus={(status, silent) =>
            applyCell(editor.workerId, editor.date, { status }, silent)
          }
          onSchedule={(label, startTime, endTime, silent) =>
            applyCell(
              editor.workerId,
              editor.date,
              { status: "SCHEDULED", label, startTime, endTime },
              silent
            )
          }
          onClear={() => clearCell(editor.workerId, editor.date)}
          onCopy={() => {
            if (editor.cell) copyCell(editor.cell);
            setEditor(null);
          }}
          onPaste={(silent) => {
            if (clipboard)
              applyCell(
                editor.workerId,
                editor.date,
                {
                  status: clipboard.status,
                  label: clipboard.label,
                  startTime: clipboard.startTime,
                  endTime: clipboard.endTime,
                },
                silent
              );
          }}
          onCancelShift={() => {
            setCancelTarget(editor);
            setEditor(null);
          }}
        />
      )}

      {cancelTarget && (
        <CancelModal
          target={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onConfirmed={() => {
            setCancelTarget(null);
            loadBoard();
            flashMsg("Shift cancelled — worker notified by text");
          }}
        />
      )}

      {showTemplates && selectedClient && (
        <TemplatesModal
          clientId={selectedClient.id}
          clientName={selectedClient.companyName}
          onClose={() => {
            setShowTemplates(false);
            admin.templates(clientId).then(setTemplates);
          }}
        />
      )}

      {smsOpen && (
        <QuickSmsTray
          workers={selectedWorkers}
          onClose={() => setSmsOpen(false)}
          onSend={sendQuickSms}
        />
      )}

      {/* Floating bulk action bar */}
      {bulkMode && (
        <div className="fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
          <div className="flex max-w-full flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-white/95 px-4 py-3 shadow-2xl backdrop-blur">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight text-emerald-700">
              <ListChecks size={16} />
              {bulkCells.size} cell{bulkCells.size === 1 ? "" : "s"} selected
            </span>

            <span className="hidden text-slate-300 sm:inline">·</span>

            <div className="flex items-center gap-1.5">
              <select
                value={bulkStatus}
                onChange={(e) => setBulkStatus(e.target.value as RotaStatus | "")}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-medium text-slate-700 outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
              >
                <option value="">Set status…</option>
                {BULK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_STYLES[s].label}
                  </option>
                ))}
              </select>

              {bulkStatus === "SCHEDULED" && (
                <>
                  <input
                    type="text"
                    value={bulkLabel}
                    onChange={(e) => setBulkLabel(e.target.value)}
                    placeholder="Shift name (optional)"
                    className="w-36 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
                  />
                  <input
                    type="time"
                    value={bulkTime}
                    onChange={(e) => setBulkTime(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
                  />
                </>
              )}

              <button
                onClick={requestBulkSet}
                disabled={bulkCells.size === 0 || !bulkStatus}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold tracking-tight text-white transition-all hover:bg-emerald-700 disabled:opacity-50"
              >
                Apply
              </button>
            </div>

            {bulkStatus === "SCHEDULED" && templates.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setBulkLabel(t.name);
                      setBulkTime(t.startTime);
                    }}
                    className="rounded-lg border border-green-200 bg-green-50 px-2 py-1 text-xs font-medium text-green-800 transition-all hover:bg-green-100"
                    title={`${t.startTime}–${t.endTime}`}
                  >
                    {t.name} {t.startTime}
                  </button>
                ))}
              </div>
            )}

            <label
              className="inline-flex cursor-pointer select-none items-center gap-1.5 text-sm font-medium text-slate-600"
              title="Bypass the SMS queue — no texts for this action"
            >
              <input
                type="checkbox"
                checked={bulkSilent}
                onChange={(e) => setBulkSilent(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-300"
              />
              Silent update
            </label>

            <span className="hidden text-slate-300 sm:inline">·</span>

            <button
              onClick={requestBulkClear}
              disabled={bulkCells.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50 disabled:opacity-50"
            >
              <Eraser size={14} /> Bulk clear
            </button>

            <button
              onClick={exitBulkMode}
              className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-700"
              title="Exit bulk edit"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Bulk confirmation modal */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-[75] grid place-items-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="mb-3 flex items-center gap-2 text-emerald-600">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-50">
                <AlertTriangle size={18} />
              </span>
              <h3 className="font-semibold tracking-tight text-slate-800">Confirm bulk action</h3>
            </div>
            <p className="mb-2 text-sm leading-relaxed text-slate-600">
              You are about to{" "}
              {bulkConfirm.kind === "clear" ? (
                <>clear the status</>
              ) : (
                <>
                  set{" "}
                  <span className="font-semibold text-slate-800">
                    {bulkConfirm.status ? STATUS_STYLES[bulkConfirm.status].label : ""}
                    {bulkConfirm.status === "SCHEDULED" &&
                    (bulkConfirm.label || bulkConfirm.startTime)
                      ? ` (${[bulkConfirm.label, bulkConfirm.startTime].filter(Boolean).join(" ")})`
                      : ""}
                  </span>
                </>
              )}{" "}
              for{" "}
              <span className="font-semibold text-slate-800">
                {bulkCells.size} selected cell{bulkCells.size === 1 ? "" : "s"}
              </span>
              .
            </p>
            <p className="mb-6 text-sm leading-relaxed text-slate-600">
              {bulkSmsCount(bulkConfirm) > 0 ? (
                <>
                  This will trigger{" "}
                  <span className="font-semibold text-slate-800">
                    {bulkSmsCount(bulkConfirm)} automated text message
                    {bulkSmsCount(bulkConfirm) === 1 ? "" : "s"}
                  </span>
                  . Proceed?
                </>
              ) : (
                <>No text messages will be sent. Proceed?</>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBulkConfirm(null)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={executeBulk}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold tracking-tight text-white transition-all hover:bg-emerald-700 disabled:opacity-50"
              >
                {bulkBusy ? <Loader2 size={15} className="animate-spin" /> : <ListChecks size={15} />}
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      {filterMenu && board && (
        <ColumnFilterMenu
          date={filterMenu.date}
          anchor={filterMenu.rect}
          workers={board.workers}
          current={filters[filterMenu.date]}
          sortDir={sort?.date === filterMenu.date ? sort.dir : null}
          onApply={(set) => {
            applyColumnFilter(filterMenu.date, set);
            setFilterMenu(null);
          }}
          onSort={(dir) => {
            setColumnSort(filterMenu.date, dir);
            setFilterMenu(null);
          }}
          onClear={() => {
            clearColumn(filterMenu.date);
            setFilterMenu(null);
          }}
          onClose={() => setFilterMenu(null)}
        />
      )}

      {flash && (
        <div className="fixed bottom-5 right-5 z-[70] rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
          {flash}
        </div>
      )}
    </div>
  );
}

// React.Fragment that accepts a key in a .map without extra markup.
function Fragment2({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Excel-style per-column sort/filter dropdown
// ---------------------------------------------------------------------------

function ColumnFilterMenu({
  date,
  anchor,
  workers,
  current,
  sortDir,
  onApply,
  onSort,
  onClear,
  onClose,
}: {
  date: string;
  anchor: { left: number; bottom: number; right: number };
  workers: BoardWorker[];
  current: Set<string> | undefined;
  sortDir: "asc" | "desc" | null;
  onApply: (set: Set<string> | null) => void;
  onSort: (dir: "asc" | "desc") => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Unique tokens present on this day across the full worker pool, ordered
  // times -> labels -> statuses -> blanks.
  const tokens = useMemo(() => {
    const set = new Set<string>();
    for (const w of workers) set.add(cellToken(w.cells[date] ?? null));
    return Array.from(set).sort(tokenSortCompare);
  }, [workers, date]);

  // Draft selection: defaults to "all checked" when the column isn't filtered.
  const [draft, setDraft] = useState<Set<string>>(() =>
    current ? new Set(current) : new Set(tokens)
  );
  const [query, setQuery] = useState("");

  const filteredTokens = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tokens.filter((t) => tokenLabel(t).toLowerCase().includes(q)) : tokens;
  }, [tokens, query]);

  const allChecked = draft.size === tokens.length && tokens.length > 0;
  const noneChecked = draft.size === 0;
  const isFiltered = !!current;

  function toggleToken(tok: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(tok)) next.delete(tok);
      else next.add(tok);
      return next;
    });
  }
  function toggleAll() {
    setDraft(allChecked ? new Set() : new Set(tokens));
  }
  function apply() {
    // Everything checked == unfiltered; collapse back to "no filter".
    onApply(draft.size === tokens.length ? null : new Set(draft));
  }

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const width = 244;
  const margin = 8;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  // Prefer anchoring the right edge of the menu under the button, but clamp.
  const left = Math.max(margin, Math.min(anchor.right - width, vw - width - margin));
  const top = anchor.bottom + 4;

  return (
    <div
      ref={panelRef}
      className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
      style={{ left, top, width, maxHeight: "60vh" }}
    >
      {/* Sort actions */}
      <div className="flex flex-col gap-0.5 border-b border-slate-100 p-1.5">
        <button
          onClick={() => onSort("asc")}
          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors ${
            sortDir === "asc"
              ? "bg-indigo-50 text-indigo-700"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          <ArrowUpAZ size={15} /> Sort ascending
          <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
            early → late
          </span>
        </button>
        <button
          onClick={() => onSort("desc")}
          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors ${
            sortDir === "desc"
              ? "bg-indigo-50 text-indigo-700"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          <ArrowDownAZ size={15} /> Sort descending
          <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
            late → early
          </span>
        </button>
      </div>

      {/* Filter search */}
      {tokens.length > 6 && (
        <div className="border-b border-slate-100 p-1.5">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search values…"
            className="w-full rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
      )}

      {/* Filter checkbox list */}
      <div className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
        {!query && (
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = !allChecked && !noneChecked;
              }}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-300"
            />
            (Select All)
          </label>
        )}
        {filteredTokens.map((tok) => {
          const isStatus = tok.startsWith("status:");
          const swatch = isStatus
            ? STATUS_STYLES[tok.slice(7) as RotaStatus]?.bg
            : tok.startsWith("time:") || tok.startsWith("label:")
            ? STATUS_STYLES.SCHEDULED.bg
            : null;
          return (
            <label
              key={tok}
              className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={draft.has(tok)}
                onChange={() => toggleToken(tok)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-300"
              />
              {swatch ? (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm border border-black/10"
                  style={{ background: swatch }}
                />
              ) : (
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-slate-300" />
              )}
              <span className="truncate">{tokenLabel(tok)}</span>
            </label>
          );
        })}
        {filteredTokens.length === 0 && (
          <p className="px-2.5 py-3 text-center text-xs text-slate-400">No matching values.</p>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-slate-100 p-1.5">
        <button
          onClick={onClear}
          disabled={!isFiltered && sortDir === null}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 disabled:opacity-40"
        >
          <FilterX size={13} /> Clear
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={noneChecked}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold tracking-tight text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge (soft premium chip using the exact spec colours)
// ---------------------------------------------------------------------------

function StatusBadge({ cell }: { cell: BoardCell }) {
  const style = STATUS_STYLES[cell.status];
  const text = cellText(cell.status, cell.startTime, cell.label);
  // A scheduled shift the worker has acknowledged via the SMS / in-app loop.
  const confirmed = cell.status === "SCHEDULED" && cell.confirmed;
  return (
    <span
      className="relative flex h-[24px] flex-1 items-center justify-center rounded-md border px-1.5 text-[11px] font-semibold leading-none tracking-tight shadow-sm"
      style={{
        background: style.bg,
        color: style.fg,
        borderColor: "rgba(0,0,0,0.06)",
        // Style A — crisp dark-green (green-800) left accent on confirmed shifts.
        ...(confirmed ? { borderLeftWidth: 4, borderLeftColor: "#166534" } : {}),
      }}
      title={confirmed ? `${text} · Confirmed by worker` : text}
    >
      {text}
      {/* Style B — tiny double-check badge in the top-right corner. */}
      {confirmed && (
        <span
          className="absolute -right-1 -top-1 grid h-[13px] w-[13px] place-items-center rounded-full border border-white text-white shadow-sm"
          style={{ background: "#166534" }}
          aria-label="Confirmed by worker"
        >
          <CheckCheck size={9} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Summary footer cell — per-day Allocated / Unallocated / Unavailable metrics
// ---------------------------------------------------------------------------

interface ColumnStats {
  allocated: number;
  confirmed: number;
  pending: number;
  unallocated: number;
  unavailable: number;
  unallocatedIds: string[];
}

function ColumnSummary({
  stats,
  pendingActive,
  unavailActive,
  onNudge,
  onTogglePending,
  onToggleUnavailable,
}: {
  stats: ColumnStats;
  pendingActive: boolean;
  unavailActive: boolean;
  onNudge: () => void;
  onTogglePending: () => void;
  onToggleUnavailable: () => void;
}) {
  return (
    <div className="space-y-1">
      {/* Allocated (green) */}
      <div className="rounded-md border border-green-200/70 bg-green-50 px-1.5 py-1 text-center">
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-[13px] font-bold leading-none text-green-800">
            {stats.allocated}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-wide text-green-700">
            Allocated
          </span>
        </div>
        {stats.allocated > 0 && (
          <button
            onClick={onTogglePending}
            title="Click to isolate the workers still pending confirmation"
            className={`mt-0.5 block w-full rounded text-[9px] font-medium leading-tight transition-colors ${
              pendingActive
                ? "bg-green-200 text-green-900"
                : "text-green-600 hover:bg-green-100"
            }`}
          >
            {stats.confirmed} Confirmed / {stats.pending} Pending
          </button>
        )}
      </div>

      {/* Unallocated (slate) + Smart Nudge bell */}
      <div className="flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-100 px-1.5 py-1">
        <div className="flex items-baseline gap-1">
          <span className="text-[13px] font-bold leading-none text-slate-700">
            {stats.unallocated}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            Unalloc.
          </span>
        </div>
        {stats.unallocated > 0 && (
          <button
            onClick={onNudge}
            title="Broadcast to this day's unallocated workers"
            className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-indigo-500 transition-colors hover:bg-indigo-100 hover:text-indigo-700"
          >
            <Bell size={12} />
          </button>
        )}
      </div>

      {/* Unavailable (rose) — clickable filter */}
      <button
        onClick={() => stats.unavailable > 0 && onToggleUnavailable()}
        title="Click to isolate unavailable workers for this day"
        className={`block w-full rounded-md border px-1.5 py-1 text-center transition-colors ${
          unavailActive
            ? "border-rose-300 bg-rose-100 ring-2 ring-rose-200"
            : "border-rose-200/70 bg-rose-50 hover:bg-rose-100"
        } ${stats.unavailable === 0 ? "cursor-default opacity-70" : ""}`}
      >
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-[13px] font-bold leading-none text-rose-700">
            {stats.unavailable}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-wide text-rose-500">
            Unavail.
          </span>
        </div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-action cell (sub-column 2)
// ---------------------------------------------------------------------------

function ActionCell({
  status,
  busy,
  hidden,
  onNudge,
  onCopy,
}: {
  status: RotaStatus | null;
  busy: boolean;
  hidden: boolean;
  onNudge: () => void;
  onCopy: () => void;
}) {
  if (hidden) return null;

  if (status === "SCHEDULED") {
    return (
      <div className="flex items-center justify-center gap-1">
        <button
          onClick={onNudge}
          disabled={busy}
          title="Nudge — send SMS reminder"
          className="grid h-[26px] w-[26px] place-items-center rounded-lg text-indigo-600 transition-all duration-200 hover:bg-indigo-100 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Bell size={13} />}
        </button>
        <button
          onClick={onCopy}
          title="Copy shift"
          className="grid h-[26px] w-[26px] place-items-center rounded-lg text-slate-400 transition-all duration-200 hover:bg-slate-100 hover:text-slate-600"
        >
          <Copy size={12} />
        </button>
      </div>
    );
  }

  if (status === "AVAILABLE") {
    return (
      <button
        onClick={onCopy}
        title="Copy"
        className="mx-auto grid h-[26px] w-[26px] place-items-center rounded-lg text-slate-400 transition-all duration-200 hover:bg-slate-100 hover:text-slate-600"
      >
        <Copy size={12} />
      </button>
    );
  }

  if (status) {
    // Rest / Unavailable / Sick / Holiday / Cancelled / No-show: minimal dot.
    return (
      <span
        className="mx-auto block h-1.5 w-1.5 rounded-full opacity-50"
        style={{ background: STATUS_STYLES[status].bg }}
        title={STATUS_STYLES[status].label}
      />
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Quick SMS slide-out tray (grid-level broadcast)
// ---------------------------------------------------------------------------

function QuickSmsTray({
  workers,
  onClose,
  onSend,
}: {
  workers: { id: string; name: string; firstName: string; lastName: string }[];
  onClose: () => void;
  onSend: (body: string) => Promise<void>;
}) {
  const [templateId, setTemplateId] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [sending, setSending] = useState(false);

  function pickTemplate(id: string) {
    setTemplateId(id);
    const t = SMS_TEMPLATES.find((x) => x.id === id);
    if (t) setBody(t.body);
  }

  async function send() {
    if (!body.trim() || workers.length === 0) return;
    setSending(true);
    try {
      await onSend(body.trim());
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-slate-900/40 backdrop-blur-sm">
      <div
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
        style={{ animation: "none" }}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
              <MessageSquare size={18} />
            </span>
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-slate-800">
                Quick Match SMS
              </h3>
              <p className="text-xs text-slate-400">
                Sending to {workers.length} worker{workers.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {/* Recipient preview */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Recipients
            </label>
            <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-2.5">
              {workers.length === 0 ? (
                <span className="text-sm text-slate-400">No workers selected.</span>
              ) : (
                workers.map((w) => (
                  <span
                    key={w.id}
                    className="inline-flex items-center rounded-lg bg-white px-2 py-1 text-xs font-medium text-slate-600 shadow-sm"
                  >
                    {w.firstName} {w.lastName}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Template picker */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Template
            </label>
            <select
              value={templateId}
              onChange={(e) => pickTemplate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm font-medium text-slate-700 outline-none transition-all focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">Choose a template…</option>
              {SMS_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Custom message */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Message
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Type a custom message, or pick a template above…"
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-sm leading-relaxed text-slate-700 outline-none transition-all focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
            <p className="mt-1 text-right text-[11px] text-slate-400">{body.length} chars</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || !body.trim() || workers.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold tracking-tight text-white shadow-sm transition-all hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Send to {workers.length}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cell editor popover
// ---------------------------------------------------------------------------

function CellEditor({
  target,
  templates,
  hasClipboard,
  onClose,
  onStatus,
  onSchedule,
  onClear,
  onCopy,
  onPaste,
  onCancelShift,
}: {
  target: EditorTarget;
  templates: ShiftTemplate[];
  hasClipboard: boolean;
  onClose: () => void;
  onStatus: (status: RotaStatus, silent: boolean) => void;
  onSchedule: (
    label: string | null,
    startTime: string | null,
    endTime: string | null,
    silent: boolean
  ) => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: (silent: boolean) => void;
  onCancelShift: () => void;
}) {
  const [time, setTime] = useState(target.cell?.startTime ?? "");
  const [name, setName] = useState(target.cell?.label ?? "");
  const [silent, setSilent] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const width = 288;
  const margin = 12;
  const gap = 6;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.min(target.rect.left, vw - width - margin);

  // Open below the cell, but flip above when there's more room there. Either way
  // cap the height to the available space and scroll internally so the status
  // grid and actions are always reachable (rows near the screen bottom).
  const spaceBelow = vh - target.rect.bottom - margin;
  const spaceAbove = target.rect.top - margin;
  const placeBelow = spaceBelow >= spaceAbove;
  const maxHeight = Math.min(
    vh - 2 * margin,
    Math.max(180, (placeBelow ? spaceBelow : spaceAbove) - gap)
  );
  const posStyle: React.CSSProperties = placeBelow
    ? { left, top: target.rect.bottom + gap, width, maxHeight }
    : { left, bottom: vh - target.rect.top + gap, width, maxHeight };

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="scrollbar-thin fixed z-[65] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
      style={posStyle}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold leading-tight tracking-tight text-slate-800">
          {target.workerName}
          <span className="block text-xs font-normal text-slate-400">
            {longDayLabel(target.date)}
          </span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
          <X size={16} />
        </button>
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium text-slate-500">
          Assign a shift — name and/or start time
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Shift name (e.g. Early A) — optional"
          className="mb-1.5 w-full rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-sm outline-none transition-all focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
        />
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Clock size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50/60 py-1.5 pl-7 pr-2 text-sm outline-none transition-all focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          </div>
          <button
            disabled={!time && !name.trim()}
            onClick={() => onSchedule(name.trim() || null, time || null, null, silent)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-indigo-700 disabled:opacity-50"
          >
            Set
          </button>
        </div>
      </div>

      {templates.length > 0 && (
        <div className="mb-3">
          <label className="mb-1 block text-[11px] font-medium text-slate-500">Templates</label>
          <div className="flex flex-wrap gap-1">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => onSchedule(t.name, t.startTime, t.endTime, silent)}
                className="rounded-lg border border-green-200 bg-green-50 px-2 py-1 text-xs font-medium text-green-800 transition-all hover:bg-green-100"
                title={`${t.startTime}–${t.endTime}`}
              >
                {t.name} {t.startTime}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium text-slate-500">
          Set status{" "}
          <span className="text-slate-400">— texts the worker (except Available/Unavailable)</span>
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {ADMIN_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => onStatus(s, silent)}
              className="rounded-lg border px-2 py-1.5 text-xs font-semibold tracking-tight transition-transform hover:scale-[1.02]"
              style={{
                background: STATUS_STYLES[s].bg,
                color: STATUS_STYLES[s].fg,
                borderColor: "rgba(0,0,0,0.06)",
              }}
            >
              {STATUS_STYLES[s].label}
            </button>
          ))}
        </div>
      </div>

      <label className="mb-3 flex cursor-pointer select-none items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-600">
        <input
          type="checkbox"
          checked={silent}
          onChange={(e) => setSilent(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-300"
        />
        Don&apos;t send text notification
        <span className="text-slate-400">(silent change)</span>
      </label>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
        <button
          onClick={onCancelShift}
          title="Mark cancelled and text the worker"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
          style={{ background: STATUS_STYLES.CANCELLED.bg }}
        >
          <Ban size={13} /> Cancel &amp; notify
        </button>
        {target.cell && (
          <button
            onClick={onCopy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50"
          >
            <Copy size={13} /> Copy
          </button>
        )}
        {hasClipboard && (
          <button
            onClick={() => onPaste(silent)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50"
          >
            <ClipboardPaste size={13} /> Paste
          </button>
        )}
        <button
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-400 transition-all hover:bg-slate-50"
        >
          <Trash2 size={13} /> Clear
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel confirmation modal
// ---------------------------------------------------------------------------

function CancelModal({
  target,
  onClose,
  onConfirmed,
}: {
  target: EditorTarget;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await admin.cancelCell(target.workerId, target.date, target.cell?.clientId ?? undefined);
      onConfirmed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-2 text-rose-600">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-50">
            <AlertTriangle size={18} />
          </span>
          <h3 className="font-semibold tracking-tight">Cancel this shift?</h3>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-slate-600">
          Are you sure you want to cancel{" "}
          <span className="font-semibold text-slate-800">{target.workerName}</span>&apos;s shift on{" "}
          <span className="font-semibold text-slate-800">{longDayLabel(target.date)}</span>? This
          will immediately alert the worker via text.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50"
          >
            Keep shift
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-rose-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
            Cancel &amp; notify
          </button>
        </div>
      </div>
    </div>
  );
}
