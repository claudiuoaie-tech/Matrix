import { EventEmitter } from "events";

/**
 * Process-wide event bus used to push real-time updates to connected admin
 * dashboards via Server-Sent Events. In a multi-instance deployment this would
 * be backed by Redis pub/sub; for Phase 2 a single-process emitter is enough.
 */
export const bus = new EventEmitter();
// Admin SSE connections + worker actions can fan out widely.
bus.setMaxListeners(100);

export type RotaEventType =
  | "allocation.updated"
  | "allocation.created"
  | "worker.updated"
  | "broadcast.sent"
  | "availability.updated"
  | "holiday.created"
  | "board.updated"
  | "message.received"
  // An outbound message's delivery status changed (Twilio callback): drives the
  // WhatsApp-style delivery ticks in the chat UI.
  | "message.status"
  // A worker cancelled an already-CONFIRMED upcoming shift: feeds the high-
  // visibility Alert Center (anti-no-show sidebar).
  | "shift.cancelled";

export interface RotaEvent {
  type: RotaEventType;
  // Arbitrary serialisable payload describing what changed.
  payload: Record<string, unknown>;
}

/** Emit a real-time event to all connected admin SSE clients. */
export function emitRotaEvent(event: RotaEvent): void {
  bus.emit("rota", event);
}
