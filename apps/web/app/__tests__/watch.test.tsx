import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import WatchBoard from "../watch/WatchBoard";
import {
  createInitialBoardState,
  DeterministicReplayEngine,
  parseJsonlEvents,
  traceReducer,
} from "@/lib/trace";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTakeoverTracePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "traces/takeover.jsonl"),
    path.resolve(process.cwd(), "../../traces/takeover.jsonl"),
    path.resolve(__dirname, "../../../../traces/takeover.jsonl"),
    path.resolve(__dirname, "../../../../../traces/takeover.jsonl"),
    path.resolve(__dirname, "../../public/traces/takeover.jsonl"),
    path.resolve(__dirname, "../../../public/traces/takeover.jsonl"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Could not locate traces/takeover.jsonl");
}

describe("Watch Board Replay Page", () => {
  it("renders WatchBoard layout and components matching DESIGN.md and mockups.html", async () => {
    const tracePath = getTakeoverTracePath();
    const traceContent = fs.readFileSync(tracePath, "utf8");

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(traceContent),
    } as unknown as Response);

    try {
      render(<WatchBoard initialTraceId="takeover" />);

      // Top control bar and Replay Picker
      expect(screen.getByText(/trace source:/i)).toBeInTheDocument();
      expect(screen.getByText(/Takeover Run/i)).toBeInTheDocument();
      expect(screen.getByText(/Load Trace File/i)).toBeInTheDocument();
      expect(screen.getByText(/Connect Live SSE/i)).toBeInTheDocument();

      // Board sections
      expect(screen.getByText("slots")).toBeInTheDocument();
      expect(screen.getByText(/budget · measured/i)).toBeInTheDocument();
      expect(screen.getByText("agent logs")).toBeInTheDocument();

      // Wait for events to load and render board state
      await waitFor(() => {
        expect(screen.getByText("2026-09-26-1418")).toBeInTheDocument();
      });

      expect(screen.getByText("github.com/acme/webapp")).toBeInTheDocument();
      expect(screen.getByText(/Researcher slot: Opus 5 failed/i)).toBeInTheDocument();
      expect(screen.getByText("timeline")).toBeInTheDocument();
      expect(screen.getByText("03:07 kill")).toBeInTheDocument();
      expect(screen.getByText("08:00 cap")).toBeInTheDocument();

      // Replaced agent stack
      expect(screen.getByText(/replaced: Opus 5/i)).toBeInTheDocument();

      // Node click opens subtask inspector modal
      const s1Button = screen.getByRole("button", { name: /Inspect subtask s1 inventory/i });
      expect(s1Button).toBeInTheDocument();
      fireEvent.click(s1Button);

      // Verify inspector modal opened
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(within(dialog).getByText(/s1 · inventory/i)).toBeInTheDocument();
        expect(within(dialog).getByText(/Fetch package manifest and lockfile from repo/i)).toBeInTheDocument();
        expect(within(dialog).getAllByText(/inventory.dependencies/i).length).toBeGreaterThan(0);
      });

      // Close inspector modal
      const closeBtn = screen.getByLabelText(/Close inspector/i);
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(screen.queryByText(/Fetch package manifest and lockfile from repo/i)).not.toBeInTheDocument();
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("proves board state at event index N is identical whether fed live-style (incremental) or replayed", () => {
    const tracePath = getTakeoverTracePath();
    const traceContent = fs.readFileSync(tracePath, "utf8");
    const events = parseJsonlEvents(traceContent);

    expect(events.length).toBeGreaterThan(0);

    const replayEngine = new DeterministicReplayEngine(events);

    // Live mode simulation: feed events incrementally one by one
    let liveState = createInitialBoardState();

    for (let i = 0; i < events.length; i++) {
      liveState = traceReducer(liveState, events[i]);
      const replayState = replayEngine.getStateAt(i);

      // Deep assert that live state and replay state are strictly equal at index i
      expect(replayState.lastSeq).toBe(liveState.lastSeq);
      expect(replayState.eventCount).toBe(liveState.eventCount);
      expect(replayState.run).toEqual(liveState.run);
      expect(replayState.budget).toEqual(liveState.budget);
      expect(replayState.slots).toEqual(liveState.slots);
      expect(replayState.plan).toEqual(liveState.plan);
      expect(replayState.routing).toEqual(liveState.routing);
      expect(replayState.takeover).toEqual(liveState.takeover);
      expect(replayState.approvals).toEqual(liveState.approvals);
      expect(replayState.criticVerdicts).toEqual(liveState.criticVerdicts);
      expect(replayState.blackboard).toEqual(liveState.blackboard);
      expect(replayState.finalReport).toEqual(liveState.finalReport);
      expect(replayState.logs.entries.length).toBe(liveState.logs.entries.length);
      expect(replayState).toEqual(liveState);
    }
  });
});
