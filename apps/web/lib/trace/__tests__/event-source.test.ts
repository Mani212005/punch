import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@punch/shared";
import {
  createEventSource,
  LocalFileEventSource,
  parseJsonlEvents,
  reduceTrace,
  StaticFileEventSource,
} from "../index.js";

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

describe("Event Source Abstraction and Takeover Trace Verification", () => {
  it("validates and parses committed traces/takeover.jsonl", () => {
    const tracePath = getTakeoverTracePath();
    expect(fs.existsSync(tracePath)).toBe(true);

    const content = fs.readFileSync(tracePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(30);

    const parsedEvents = parseJsonlEvents(content);
    expect(parsedEvents.length).toBe(lines.length);

    // Assert every event parses cleanly against TraceEvent schema
    for (let i = 0; i < parsedEvents.length; i++) {
      const event = parsedEvents[i];
      expect(event.seq).toBe(i);
      expect(event.runId).toBe("2026-09-26-takeover");
      expect(event.ts).toBeGreaterThan(0);
    }

    // Verify reduced board state from the whole takeover trace
    const finalState = reduceTrace(parsedEvents);
    expect(finalState.run.status).toBe("completed");
    expect(finalState.run.repoUrl).toBe("https://github.com/expressjs/express");
    expect(finalState.plan.subtasks.length).toBe(4);
    expect(finalState.slots.researcher.agentId).toBe("gemini");
    expect(finalState.slots.researcher.replaced).toHaveLength(1);
    expect(finalState.slots.researcher.replaced[0].agentId).toBe("opus");
    expect(finalState.slots.researcher.replaced[0].reason.kind).toBe("operator_kill");
    expect(finalState.takeover.active).toBeDefined();
    expect(finalState.takeover.active?.status).toBe("replaced");
    expect(finalState.takeover.active?.handoff.cachedResultCount).toBe(2);
    expect(finalState.approvals).toHaveLength(0);
    expect(finalState.blackboard["report"]).toBeDefined();
  });

  it("StaticFileEventSource fetches and streams events", async () => {
    const mockJsonl = `{"runId":"r1","seq":0,"ts":100,"kind":"run.started","task":{"repoUrl":"http://a"},"mode":"auto","budgets":{"maxSteps":10,"maxUsd":1,"maxWallClockMs":1000},"chaos":[]}\n{"runId":"r1","seq":1,"ts":110,"kind":"run.finished","status":"completed"}`;

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockJsonl),
    } as unknown as Response);

    try {
      const source = new StaticFileEventSource("test-trace", "/traces");
      const events = await source.fetchAll();
      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe("run.started");
      expect(events[1].kind).toBe("run.finished");

      const streamed: TraceEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        source.subscribe(
          (e) => streamed.push(e),
          reject,
          () => resolve(),
        );
      });
      expect(streamed).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("LocalFileEventSource parses File instance", async () => {
    const mockJsonl = `{"runId":"r2","seq":0,"ts":100,"kind":"run.started","task":{"repoUrl":"http://b"},"mode":"auto","budgets":{"maxSteps":10,"maxUsd":1,"maxWallClockMs":1000},"chaos":[]}`;
    const file = new File([mockJsonl], "local.jsonl", { type: "text/plain" });

    const source = new LocalFileEventSource(file);
    expect(source.kind).toBe("file");
    expect(source.id).toBe("local.jsonl");

    const events = await source.fetchAll();
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe("r2");
  });

  it("createEventSource factory creates appropriate source instances", () => {
    const staticSrc = createEventSource({ kind: "static", traceId: "takeover" });
    expect(staticSrc.kind).toBe("static");

    const sseSrc = createEventSource({
      kind: "sse",
      engineUrl: "http://localhost:4141",
      token: "test-token",
      runId: "123",
    });
    expect(sseSrc.kind).toBe("sse");

    const tunnelSrc = createEventSource({
      kind: "viewer-tunnel",
      tunnelUrl: "https://tunnel.example.com",
      viewerToken: "v-token",
    });
    expect(tunnelSrc.kind).toBe("viewer-tunnel");
  });
});
