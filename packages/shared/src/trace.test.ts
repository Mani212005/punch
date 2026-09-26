import { describe, expect, it } from "vitest";
import { TRACE_EVENT_KINDS, TraceEvent, type TraceEventKind } from "./trace.js";

const entry = {
  key: "vulns",
  version: 1,
  status: "ok" as const,
  value: { count: 2 },
  evidence: [{ source: "osv", url: "https://api.osv.dev/v1/query" }],
  writtenBy: { role: "researcher", agentId: "a1", subtaskId: "s1" },
  ts: 1_700_000_000_000,
};
const finding = {
  claim: "lodash 4.17.99 exists",
  problem: "no such version",
  severity: "blocker" as const,
};
const budget = { stepsRemaining: 10, usdRemaining: 1.5, msRemaining: 60_000 };
const who = { role: "researcher" as const, agentId: "a1", subtaskId: "s1" };
const subtask = {
  id: "s1",
  title: "Inventory",
  description: "List deps",
  dependsOn: [],
  roleHint: "researcher" as const,
  output: { key: "deps" },
  inputKeys: [],
  status: "pending" as const,
};

const payloads: { [K in TraceEventKind]: Record<string, unknown> } = {
  "run.started": {
    task: { repoUrl: "https://github.com/a/b" },
    mode: "auto",
    budgets: { maxSteps: 100, maxUsd: 5, maxWallClockMs: 600_000 },
    chaos: ["stall:researcher"],
  },
  "route.decided": {
    role: "researcher",
    agentId: "a1",
    provenance: "jev",
    probabilities: [{ agentId: "a1", probability: 0.7 }],
    confidence: 0.7,
    difficulty: "moderate",
  },
  "route.skipped": { role: "critic", reason: "pinned" },
  "plan.created": { subtasks: [subtask] },
  "slot.assigned": {
    role: "researcher",
    agentId: "a1",
    provenance: "pin",
    standby: [{ agentId: "a2", probability: 0.2 }],
  },
  "agent.started": { ...who, attempt: 1, effort: "medium" },
  "agent.heartbeat": who,
  "agent.text": { ...who, text: "hello" },
  "agent.opaque_output": { ...who, text: "cli output" },
  "tool.called": { ...who, callId: "c1", tool: "osv_query", input: { name: "lodash" } },
  "tool.result": {
    callId: "c1",
    tool: "osv_query",
    ok: true,
    cached: true,
    latencyMs: 0,
    retries: 0,
    output: { vulns: [] },
  },
  "tool.retry": {
    callId: "c1",
    tool: "osv_query",
    attempt: 1,
    delayMs: 250,
    errorClass: "transient",
    error: "503",
  },
  "fallback.used": { tool: "osv", from: "osv", to: "gh-advisory", reason: "permanent" },
  "blackboard.written": { key: "vulns", entry },
  "slot.stalled": { ...who, silentMs: 46_000, nudged: true },
  "slot.failed": {
    ...who,
    reason: { kind: "operator_kill", detail: "killed by operator" },
    classification: "permanent",
  },
  "slot.rejected": { ...who, rejections: 2, findings: [finding] },
  "slot.replacing": {
    role: "researcher",
    subtaskId: "s1",
    failedAgentId: "a1",
    replacementAgentId: "a2",
    reason: { kind: "failed", detail: "503" },
    handoff: {
      inputKeys: ["deps"],
      cachedResultCount: 3,
      partialNotes: "half done",
      criticFindings: null,
      budget,
    },
    selection: {
      provenance: "standby",
      rank: 1,
      probability: 0.2,
      skipped: [{ agentId: "a3", reason: "same provider failed" }],
    },
    detectionMs: 1200,
  },
  "slot.replaced": {
    role: "researcher",
    subtaskId: "s1",
    failedAgentId: "a1",
    replacementAgentId: "a2",
    takeoverMs: 1800,
  },
  "slot.exhausted": {
    role: "researcher",
    subtaskId: "s1",
    reason: "no replacement",
    degradedKey: "deps",
  },
  "critic.verdict": {
    subtaskId: "s1",
    agentId: "a4",
    verdict: "rejected",
    attempt: 1,
    findings: [finding],
  },
  "approval.requested": { approvalId: "ap1", tool: "github_create_issue", payload: { title: "x" } },
  "approval.granted": { approvalId: "ap1", decidedBy: "cli" },
  "approval.denied": { approvalId: "ap1", decidedBy: "console", reason: "nope" },
  "budget.checked": {
    steps: { used: 3, max: 100 },
    usd: { used: 0.1, max: 5 },
    ms: { used: 1000, max: 600_000 },
    exceeded: null,
  },
  "replan.triggered": { subtaskId: "s2", reason: "permanent failure with dependents" },
  "compensation.ran": { action: "close_issue", ok: true },
  "run.finished": { status: "degraded", summary: "one subtask degraded", reportKey: "report" },
};

// plan.md 3.7, verbatim.
const PLAN_KINDS = [
  "run.started",
  "route.decided",
  "route.skipped",
  "plan.created",
  "slot.assigned",
  "agent.started",
  "agent.heartbeat",
  "agent.text",
  "agent.opaque_output",
  "tool.called",
  "tool.result",
  "tool.retry",
  "fallback.used",
  "blackboard.written",
  "slot.stalled",
  "slot.failed",
  "slot.rejected",
  "slot.replacing",
  "slot.replaced",
  "slot.exhausted",
  "critic.verdict",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "budget.checked",
  "replan.triggered",
  "compensation.ran",
  "run.finished",
];

describe("trace event union", () => {
  it("covers exactly the kinds in plan.md 3.7", () => {
    expect([...TRACE_EVENT_KINDS].sort()).toEqual([...PLAN_KINDS].sort());
  });

  it.each(PLAN_KINDS)("%s round-trips through JSON", (kind) => {
    const event = {
      runId: "r1",
      seq: 7,
      ts: 1_700_000_000_000,
      kind,
      ...payloads[kind as TraceEventKind],
    };
    const parsed = TraceEvent.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
    expect(TraceEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects events missing runId, seq, or ts", () => {
    expect(
      TraceEvent.safeParse({ kind: "route.skipped", role: "critic", reason: "x" }).success,
    ).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(TraceEvent.safeParse({ runId: "r", seq: 0, ts: 0, kind: "nope" }).success).toBe(false);
  });
});
