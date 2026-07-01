"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { admin } from "./api";
import type { RotaEvent } from "./types";

export type RotaEventHandler = (event: RotaEvent) => void;
export type Subscribe = (handler: RotaEventHandler) => () => void;

interface UseRotaEvents {
  connected: boolean;
  /**
   * Register a handler invoked for EVERY rota event. Returns an unsubscribe
   * function. Stable identity across renders, so an effect that subscribes runs
   * exactly once.
   */
  subscribe: Subscribe;
}

/**
 * Subscribes to the admin SSE stream. Every event is delivered SYNCHRONOUSLY to
 * every registered subscriber straight out of the EventSource `onmessage`
 * handler — it never passes through a single React state value. That's the whole
 * point: routing events through one `lastEvent` state let React batch two
 * synchronous back-to-back events (e.g. board.updated + shift.cancelled) into a
 * single commit, silently dropping the first. A subscriber set has no such race —
 * each event fires each handler once, in order, with 100% delivery.
 */
export function useRotaEvents(): UseRotaEvents {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Set<RotaEventHandler>>(new Set());

  const subscribe = useCallback<Subscribe>((handler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    const es = new EventSource(admin.eventsUrl());

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      let event: RotaEvent | null = null;
      try {
        const parsed = JSON.parse(msg.data) as RotaEvent;
        if (parsed?.type) event = parsed;
      } catch {
        return; // heartbeat / non-JSON frame
      }
      if (!event) return;
      // Fan out to every subscriber. A throwing handler must not stop the others
      // or break the stream, so each is isolated.
      for (const handler of handlersRef.current) {
        try {
          handler(event);
        } catch (err) {
          console.error("[useRotaEvents] subscriber threw:", err);
        }
      }
    };

    return () => es.close();
  }, []);

  return { connected, subscribe };
}

/**
 * Convenience hook: run `handler` for every rota event over the given
 * `subscribe`. The latest handler is kept in a ref so it always sees fresh state
 * without re-subscribing, and `subscribe` is stable so this attaches exactly once.
 */
export function useRotaEventListener(subscribe: Subscribe, handler: RotaEventHandler): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}
