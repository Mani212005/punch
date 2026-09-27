import type { TraceEvent } from "@punch/shared";
import { describe, expect, it } from "vitest";
import {
  assertEvidencePreserved,
  collectResilienceMetrics,
  renderResilienceSummary,
  summarizeResilience,
} from "./resilience.js";

let seq = 0;
const ev = (e: Record<string, unknown>): TraceEvent =>
  ({ runId: "r", ts: 0, seq: seq++, ...e }) as unknown as TraceEvent;

const who = { role: "reachability", agentId: "a", subtaskId: "s1" };
const call = (id: string, cached = false): TraceEvent[] => [
  ev({ kind: "tool.called", ...who, callId: id, tool: "t", input: { id } }),
  ev({ kind: "tool.result", callId: id, tool: "t", ok: true, cached, latencyMs: 1, retries: 0 }),
];

function takeover(carried: number, calls = 2): TraceEvent[] {
  seq = 0;
  return [
    ...Array.from({ length: calls }, (_, i) => call(`c${i}`)).flat(),
    ev({ kind: "slot.failed", ...who, reason: { kind: "failed", detail: "boom" } }),
    ev({
      kind: "slot.replacing",
      role: "reachability",
      subtaskId: "s1",
      failedAgentId: "a",
      replacementAgentId: "b",
      reason: { kind: "failed", detail: "boom" },
      handoff: {
        inputKeys: [],
        cachedResultCount: carried,
        partialNotes: null,
        criticFindings: null,
        budget: { stepsRemaining: 1, usdRemaining: 1, msRemaining: 1 },
      },
      selection: { provenance: "standby", skipped: [] },
      detectionMs: 4,
    }),
    ev({
      kind: "slot.replaced",
      role: "reachability",
      subtaskId: "s1",
      failedAgentId: "a",
      replacementAgentId: "b",
      takeoverMs: 6,
    }),
    ev({ kind: "run.finished", status: "completed" }),
  ];
}

const run = (events: TraceEvent[], mode = "crash") =>
  collectResilienceMetrics({ runIndex: 1, runId: "r", mode, events, durationMs: 10 });

describe("resilience metrics", () => {
  it("counts a takeover, its latency and full evidence preservation", () => {
    const m = run(takeover(2));
    expect(m).toMatchObject({
      completed: true,
      agentFailures: 1,
      recoveries: 1,
      contextExpected: 2,
      contextPreserved: 2,
      takeoverMsList: [6],
      detectionMsList: [4],
    });
    const summary = summarizeResilience("t", [m]);
    expect(summary.takeoverSuccessRate).toBe(1);
    expect(summary.contextLostPct).toBe(0);
    expect(() => assertEvidencePreserved(summary)).not.toThrow();
    expect(renderResilienceSummary(summary)).toContain("Context lost: 0.0%");
  });

  it("assertEvidencePreserved fails when a handoff carried less than the agent gathered", () => {
    const summary = summarizeResilience("t", [run(takeover(1))]);
    expect(summary.contextLostPct).toBe(50);
    expect(() => assertEvidencePreserved(summary)).toThrow(
      /evidence preservation is 50.0%.*1 of 2/,
    );
  });

  it("ignores cached results and other slots' calls when counting what was gathered", () => {
    seq = 0;
    const events = [
      ...call("c0"),
      ...call("c1", true),
      ev({
        kind: "tool.called",
        role: "impact",
        agentId: "x",
        subtaskId: "s2",
        callId: "o",
        tool: "t",
        input: {},
      }),
      ev({
        kind: "tool.result",
        callId: "o",
        tool: "t",
        ok: true,
        cached: false,
        latencyMs: 1,
        retries: 0,
      }),
      ...takeover(1)
        .filter((e) => e.kind !== "tool.called" && e.kind !== "tool.result")
        .map((e) => ({ ...e, seq: seq++ }) as TraceEvent),
    ];
    const m = run(events);
    expect(m.contextExpected).toBe(1);
    expect(m.contextPreserved).toBe(1);
  });

  it("does not count a rejection routed to a replan as an agent failure", () => {
    seq = 0;
    const m = run([
      ev({ kind: "slot.rejected", ...who, rejections: 2, findings: [] }),
      ev({ kind: "replan.triggered", subtaskId: "s1", reason: "critic" }),
      ev({
        kind: "critic.verdict",
        subtaskId: "s1",
        agentId: "c",
        verdict: "rejected",
        attempt: 1,
      }),
      ev({
        kind: "critic.verdict",
        subtaskId: "s1",
        agentId: "c",
        verdict: "accepted",
        attempt: 2,
      }),
      ev({ kind: "approval.requested", approvalId: "a", tool: "x", payload: {} }),
      ev({ kind: "run.finished", status: "degraded" }),
    ]);
    expect(m).toMatchObject({
      agentFailures: 0,
      criticVerdicts: 2,
      criticRejections: 1,
      approvalsRequested: 1,
      approvalsGranted: 0,
      degraded: true,
      completed: false,
    });
  });

  it("counts an exhausted slot as an unrecovered failure and a retried tool as recovered", () => {
    seq = 0;
    const m = run([
      ev({ kind: "tool.called", ...who, callId: "c", tool: "osv", input: {} }),
      ev({
        kind: "tool.result",
        callId: "c",
        tool: "osv",
        ok: true,
        cached: false,
        latencyMs: 1,
        retries: 2,
      }),
      ev({ kind: "slot.failed", ...who, reason: { kind: "failed", detail: "x" } }),
      ev({ kind: "slot.exhausted", role: "reachability", subtaskId: "s1", reason: "none left" }),
      ev({ kind: "run.finished", status: "degraded" }),
    ]);
    expect(m).toMatchObject({
      agentFailures: 1,
      recoveries: 0,
      exhausted: 1,
      toolFaults: 1,
      toolRecovered: 1,
    });
    const summary = summarizeResilience("t", [m]);
    expect(summary.takeoverSuccessRate).toBe(0);
    expect(summary.toolRecoveryRate).toBe(1);
  });
});
