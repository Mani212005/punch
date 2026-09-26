import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import WatchBoard from "../watch/WatchBoard";
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
  it("renders WatchBoard layout and controls", async () => {
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
    } finally {
      global.fetch = originalFetch;
    }
  });
});
