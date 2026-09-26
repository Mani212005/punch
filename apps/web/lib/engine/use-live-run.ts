"use client";

import { useEffect, useMemo, useState } from "react";
import type { TraceEvent } from "@punch/shared";
import { SSEEventSource } from "@/lib/trace/event-source";
import { createInitialBoardState, traceReducer } from "@/lib/trace/reducer";
import type { BoardState } from "@/lib/trace/types";
import type { Pairing } from "./client";

export interface LiveRun {
  board: BoardState;
  events: TraceEvent[];
  streaming: boolean;
  error: string | null;
}

const EMPTY: LiveRun = {
  board: createInitialBoardState(),
  events: [],
  streaming: false,
  error: null,
};

/**
 * Follow one run over the engine's SSE stream and fold it through the same
 * reducer the watch board uses, so the console and the board never disagree.
 */
export function useLiveRun(pairing: Pairing | null, runId: string | null): LiveRun {
  const [live, setLive] = useState<LiveRun>(EMPTY);
  const engineUrl = pairing?.engineUrl;
  const token = pairing?.token;

  const source = useMemo(
    () => (engineUrl && token && runId ? new SSEEventSource(engineUrl, token, runId) : null),
    [engineUrl, token, runId],
  );

  useEffect(() => {
    if (!source) {
      setLive(EMPTY);
      return;
    }
    setLive({ ...EMPTY, board: createInitialBoardState(), streaming: true });
    return source.subscribe(
      (event) =>
        setLive((prev) => ({
          ...prev,
          board: traceReducer(prev.board, event),
          events: [...prev.events, event],
        })),
      (error) => setLive((prev) => ({ ...prev, streaming: false, error: error.message })),
      () => setLive((prev) => ({ ...prev, streaming: false })),
    );
  }, [source]);

  return live;
}
