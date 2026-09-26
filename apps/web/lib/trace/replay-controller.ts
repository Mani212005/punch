"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TraceEvent } from "@punch/shared";
import { createInitialBoardState, traceReducer } from "./reducer";
import type { TraceEventSource } from "./event-source";
import type { BoardState } from "./types";

export interface ReplayControllerOptions {
  autoPlay?: boolean;
  defaultSpeed?: 1 | 4;
  stepDelayMs?: number;
}

export class DeterministicReplayEngine {
  private events: TraceEvent[] = [];
  private statesCache: (BoardState | undefined)[] = [];

  constructor(events: TraceEvent[] = []) {
    this.setEvents(events);
  }

  setEvents(events: TraceEvent[]): void {
    this.events = events;
    this.statesCache = new Array(events.length);
  }

  appendEvent(event: TraceEvent): void {
    this.events.push(event);
    this.statesCache.push(undefined);
  }

  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  getEventCount(): number {
    return this.events.length;
  }

  getStateAt(index: number): BoardState {
    if (index < 0 || this.events.length === 0) {
      return createInitialBoardState();
    }

    const clampedIndex = Math.min(index, this.events.length - 1);

    // If cached, return
    if (this.statesCache[clampedIndex] !== undefined) {
      return this.statesCache[clampedIndex]!;
    }

    // Find nearest cached state before clampedIndex
    let startIndex = -1;
    let currentState = createInitialBoardState();

    for (let i = clampedIndex - 1; i >= 0; i--) {
      if (this.statesCache[i] !== undefined) {
        startIndex = i;
        currentState = this.statesCache[i]!;
        break;
      }
    }

    // Replay from nearest cached state to target index
    for (let i = startIndex + 1; i <= clampedIndex; i++) {
      currentState = traceReducer(currentState, this.events[i]);
      // Cache intermediate state
      this.statesCache[i] = currentState;
    }

    return currentState;
  }
}

export function useReplayController(
  eventSource: TraceEventSource | null,
  options: ReplayControllerOptions = {},
) {
  const { autoPlay = false, defaultSpeed = 1, stepDelayMs = 400 } = options;

  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState<boolean>(autoPlay);
  const [speed, setSpeedState] = useState<1 | 4>(defaultSpeed);
  const [loading, setLoading] = useState<boolean>(Boolean(eventSource));
  const [error, setError] = useState<Error | null>(null);

  const engine = useMemo(() => new DeterministicReplayEngine(events), [events]);

  const state = useMemo(() => {
    return engine.getStateAt(currentIndex);
  }, [engine, currentIndex]);

  // Load from event source
  useEffect(() => {
    if (!eventSource) {
      setEvents([]);
      setCurrentIndex(-1);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const loadedEvents: TraceEvent[] = [];

    const unsubscribe = eventSource.subscribe(
      (event) => {
        loadedEvents.push(event);
        setEvents([...loadedEvents]);
        // For static traces, start at full or first index based on autoPlay
        if (loadedEvents.length === 1) {
          setCurrentIndex(0);
        }
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
      () => {
        setLoading(false);
        if (loadedEvents.length > 0) {
          setEvents(loadedEvents);
          // When static trace completes loading, if not playing, jump to end
          if (!autoPlay) {
            setCurrentIndex(loadedEvents.length - 1);
          }
        }
      },
    );

    return () => {
      unsubscribe();
    };
  }, [eventSource, autoPlay]);

  // Playback timer
  useEffect(() => {
    if (!isPlaying || events.length === 0) return;

    const intervalTime = Math.max(50, Math.floor(stepDelayMs / speed));

    const timer = setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= events.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [isPlaying, events.length, speed, stepDelayMs]);

  const play = useCallback(
    (newSpeed?: 1 | 4) => {
      if (newSpeed) setSpeedState(newSpeed);
      setCurrentIndex((prev) => {
        if (prev >= events.length - 1) {
          return 0;
        }
        return prev;
      });
      setIsPlaying(true);
    },
    [events.length],
  );

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, pause, play]);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setCurrentIndex((prev) => Math.min(events.length - 1, prev + 1));
  }, [events.length]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const scrubTo = useCallback(
    (index: number) => {
      setIsPlaying(false);
      setCurrentIndex(Math.max(-1, Math.min(events.length - 1, index)));
    },
    [events.length],
  );

  const setSpeed = useCallback((newSpeed: 1 | 4) => {
    setSpeedState(newSpeed);
  }, []);

  return {
    state,
    events,
    currentIndex,
    totalEvents: events.length,
    isPlaying,
    speed,
    loading,
    error,
    play,
    pause,
    togglePlay,
    stepForward,
    stepBackward,
    scrubTo,
    setSpeed,
  };
}
