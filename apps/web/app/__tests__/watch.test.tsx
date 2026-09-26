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

      // Top control bar
      expect(screen.getByText(/trace source:/i)).toBeInTheDocument();
      expect(screen.getByText(/Takeover Run/i)).toBeInTheDocument();
      expect(screen.getByText(/Load Local File/i)).toBeInTheDocument();

      // Board sections
      expect(screen.getByText("slots")).toBeInTheDocument();
      expect(screen.getByText(/budget · measured/i)).toBeInTheDocument();
      expect(screen.getByText("agent logs")).toBeInTheDocument();

      // Wait for events to load and render board state
      await waitFor(() => {
        expect(screen.getByText("2026-09-26-takeover")).toBeInTheDocument();
      });

      expect(screen.getByText("https://github.com/expressjs/express")).toBeInTheDocument();
      expect(screen.getByText(/RESEARCHER slot:/i)).toBeInTheDocument();
      expect(screen.getByText(/plan graph · 4 subtasks/i)).toBeInTheDocument();
      expect(screen.getByText(/timeline · event 90 of 90/i)).toBeInTheDocument();

      // Kill marker and banner share the slot.failed timestamp (run-relative)
      expect(screen.getByText("00:01 kill")).toBeInTheDocument();
      expect(screen.getByText("02:00 cap")).toBeInTheDocument();

      // Replaced agent stack
      expect(screen.getByText(/replaced: Opus/i)).toBeInTheDocument();

      // Node click opens subtask inspector modal
      const s1Button = screen.getByRole("button", {
        name: /Inspect subtask s1 Inventory dependencies/i,
      });
      expect(s1Button).toBeInTheDocument();
      fireEvent.click(s1Button);

      // Verify inspector modal opened
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(within(dialog).getByText(/s1 · Inventory dependencies/i)).toBeInTheDocument();
        expect(
          within(dialog).getByText(/Read package.json and package-lock.json/i),
        ).toBeInTheDocument();
      });

      // Close inspector modal
      const closeBtn = screen.getByLabelText(/Close inspector/i);
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(
          screen.queryByText(/Read package.json and package-lock.json/i),
        ).not.toBeInTheDocument();
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

  it("viewer URL mode streams read-only with no Kill/Approve/Stop shown", async () => {
    const tracePath = getTakeoverTracePath();
    const traceContent = fs.readFileSync(tracePath, "utf8");
    const sseText =
      traceContent
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `data: ${line.trim()}`)
        .join("\n\n") + "\n\ndata: [DONE]\n\n";

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation((url: unknown) => {
      const href = String(url);
      if (href.includes("/runs/") && href.includes("/events")) {
        return Promise.resolve(new Response(sseText, { status: 200 }));
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(traceContent),
      } as unknown as Response);
    });

    try {
      render(<WatchBoard initialTraceId="takeover" />);

      // Static replay first: the Stop control is visible in non-viewer mode.
      await waitFor(() => {
        expect(screen.getByText("2026-09-26-takeover")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

      // Paste the viewer URL printed by `punch serve --tunnel` and connect.
      fireEvent.click(screen.getByRole("button", { name: /Watch via Viewer URL/i }));
      fireEvent.change(screen.getByLabelText(/viewer url/i), {
        target: { value: "https://tunnel.example.com/?token=view-123" },
      });
      fireEvent.change(screen.getByLabelText(/run id/i), {
        target: { value: "2026-09-26-takeover" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Watch Stream/i }));

      // Read-only banner appears, the live run streams, and no control is shown.
      await waitFor(() => {
        expect(screen.getByText(/read-only viewer/i)).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("2026-09-26-takeover")).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /kill/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.getByText("read-only")).toBeInTheDocument();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
