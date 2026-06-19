"use client";

import { useEffect, useRef, useState } from "react";
import { admin } from "./api";
import type { RotaEvent } from "./types";

interface UseRotaEvents {
  connected: boolean;
  lastEvent: RotaEvent | null;
}

/**
 * Subscribes to the admin SSE stream and surfaces the latest rota event plus a
 * live/offline connection flag. Components re-fetch their data when `lastEvent`
 * changes, so SMS replies and worker actions flash onto the dashboard without a
 * manual refresh.
 */
export function useRotaEvents(): UseRotaEvents {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RotaEvent | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(admin.eventsUrl());
    sourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as RotaEvent;
        if (data?.type) setLastEvent(data);
      } catch {
        /* ignore heartbeats / non-JSON frames */
      }
    };

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, []);

  return { connected, lastEvent };
}
