import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@punch/shared";
import {
  createInitialBoardState,
  DeterministicReplayEngine,
  reduceTrace,
  traceReducer,
} from "../index.js";

describe("Trace Reducer", () => {
  it("initializes empty board state with default slot lanes", () => {
    const state = createInitialBoardState();
    expect(state.run.status).toBe("pending");
    expect(state.slots.planner.role).toBe("planner");
    expect(state.slots.researcher.role).toBe("researcher");
    expect(state.slots.executor.role).toBe("executor");
    expect(state.slots.critic.role).toBe("critic");
    expect(state.logs.entries).toHaveLength(0);
    expect(state.approvals).toHaveLength(0);
    expect(state.criticVerdicts).toHaveLength(0);
  });

  it("handles run.started event", () => {
    const event: TraceEvent = {
      runId: "run-100",
      seq: 0,
      ts: 1000,
      kind: "run.started",
      task: {
        repoUrl: "https://github.com/acme/punch-demo",
        brief: "Triage repo",
        budgetUsd: 5,
      },
      mode: "auto",
      budgets: { maxSteps: 50, maxUsd: 5, maxWallClockMs: 60000 },
      orchestratorAgentId: "opus-5-5",
      chaos: ["stall:researcher"],
    };

    const state = traceReducer(createInitialBoardState(), event);
    expect(state.run.runId).toBe("run-100");
    expect(state.run.status).toBe("running");
    expect(state.run.repoUrl).toBe("https://github.com/acme/punch-demo");
    expect(state.run.mode).toBe("auto");
    expect(state.run.orchestratorAgentId).toBe("opus-5-5");
    expect(state.budget.steps.max).toBe(50);
    expect(state.budget.usd.max).toBe(5);
    expect(state.budget.ms.max).toBe(60000);
    expect(state.logs.entries).toHaveLength(1);
  });

  it("handles route.decided and route.skipped", () => {
    let state = createInitialBoardState();

    const decideEvent: TraceEvent = {
      runId: "run-100",
      seq: 1,
      ts: 1010,
      kind: "route.decided",
      role: "researcher",
      agentId: "opus-5",
      provenance: "jev",
      probabilities: [
        { agentId: "opus-5", probability: 0.7 },
        { agentId: "gemini-flash", probability: 0.3 },
      ],
      confidence: 0.85,
      difficulty: "moderate",
    };

    state = traceReducer(state, decideEvent);
    expect(state.routing.researcher.agentId).toBe("opus-5");
    expect(state.routing.researcher.confidence).toBe(0.85);
    expect(state.routing.researcher.difficulty).toBe("moderate");

    const skipEvent: TraceEvent = {
      runId: "run-100",
      seq: 2,
      ts: 1020,
      kind: "route.skipped",
      role: "critic",
      reason: "pinned in config",
    };

    state = traceReducer(state, skipEvent);
    expect(state.routing.critic.skipped).toBe(true);
    expect(state.routing.critic.skippedReason).toBe("pinned in config");
  });

  it("handles plan.created", () => {
    const event: TraceEvent = {
      runId: "run-100",
      seq: 3,
      ts: 1030,
      kind: "plan.created",
      subtasks: [
        {
          id: "s1",
          title: "inventory",
          description: "Read package.json",
          dependsOn: [],
          roleHint: "researcher",
          output: { key: "inv" },
          inputKeys: [],
          status: "pending",
        },
      ],
    };

    const state = traceReducer(createInitialBoardState(), event);
    expect(state.plan.subtasks).toHaveLength(1);
    expect(state.plan.subtasks[0].id).toBe("s1");
  });

  it("handles slot.assigned", () => {
    const event: TraceEvent = {
      runId: "run-100",
      seq: 4,
      ts: 1040,
      kind: "slot.assigned",
      role: "researcher",
      agentId: "opus-5",
      provenance: "jev",
      standby: [{ agentId: "gemini-flash", probability: 0.3 }],
    };

    const state = traceReducer(createInitialBoardState(), event);
    expect(state.slots.researcher.agentId).toBe("opus-5");
    expect(state.slots.researcher.state).toBe("assigned");
    expect(state.slots.researcher.standby).toHaveLength(1);
  });

  it("handles agent.started, heartbeat, text, and opaque_output", () => {
    let state = createInitialBoardState();

    state = traceReducer(state, {
      runId: "run-100",
      seq: 5,
      ts: 1050,
      kind: "agent.started",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s1",
      attempt: 1,
      effort: "medium",
    });
    expect(state.slots.researcher.state).toBe("running");
    expect(state.slots.researcher.currentSubtaskId).toBe("s1");
    expect(state.timeline.spans).toHaveLength(1);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 6,
      ts: 1060,
      kind: "agent.heartbeat",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s1",
    });
    expect(state.slots.researcher.lastHeartbeatTs).toBe(1060);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 7,
      ts: 1070,
      kind: "agent.text",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s1",
      text: "Checking packages",
    });
    expect(state.slots.researcher.turns).toBe(1);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 8,
      ts: 1080,
      kind: "agent.opaque_output",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s1",
      text: "CLI raw output",
    });
    expect(state.logs.entries).toHaveLength(3);
  });

  it("handles tool calling, retries, fallbacks, and results", () => {
    let state = createInitialBoardState();

    state = traceReducer(state, {
      runId: "run-100",
      seq: 9,
      ts: 1090,
      kind: "tool.called",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s1",
      callId: "c1",
      tool: "osv_query",
      input: { pkg: "lodash" },
    });
    expect(state.timeline.spans).toHaveLength(1);
    expect(state.timeline.spans[0].status).toBe("running");

    state = traceReducer(state, {
      runId: "run-100",
      seq: 10,
      ts: 1095,
      kind: "tool.retry",
      callId: "c1",
      tool: "osv_query",
      attempt: 1,
      delayMs: 500,
      errorClass: "transient",
      error: "503 timeout",
    });

    state = traceReducer(state, {
      runId: "run-100",
      seq: 11,
      ts: 1098,
      kind: "fallback.used",
      tool: "osv_query",
      from: "osv",
      to: "gh-advisory",
      reason: "OSV down",
    });

    state = traceReducer(state, {
      runId: "run-100",
      seq: 12,
      ts: 1100,
      kind: "tool.result",
      callId: "c1",
      tool: "osv_query",
      ok: true,
      cached: false,
      latencyMs: 10,
      retries: 1,
      output: { vulns: [] },
    });
    expect(state.timeline.spans[0].status).toBe("completed");
    expect(state.timeline.spans[0].endTs).toBe(1100);
  });

  it("handles blackboard.written and updates subtask status", () => {
    let state = createInitialBoardState();
    state.plan.subtasks = [
      {
        id: "s1",
        title: "inventory",
        description: "",
        dependsOn: [],
        roleHint: "researcher",
        output: { key: "inv.deps" },
        inputKeys: [],
        status: "running",
      },
    ];

    state = traceReducer(state, {
      runId: "run-100",
      seq: 13,
      ts: 1130,
      kind: "blackboard.written",
      key: "inv.deps",
      entry: {
        key: "inv.deps",
        version: 1,
        status: "ok",
        value: { total: 42 },
        evidence: [{ source: "tool" }],
        writtenBy: { role: "researcher", agentId: "opus-5", subtaskId: "s1" },
        ts: 1130,
      },
    });

    expect(state.blackboard["inv.deps"]).toBeDefined();
    expect(state.plan.subtasks[0].status).toBe("completed");
  });

  it("handles slot failure, rejection, stall, and exhaustion", () => {
    let state = createInitialBoardState();

    state = traceReducer(state, {
      runId: "run-100",
      seq: 14,
      ts: 1140,
      kind: "slot.stalled",
      role: "researcher",
      agentId: "opus-5",
      silentMs: 45000,
      nudged: true,
    });
    expect(state.slots.researcher.state).toBe("stalled");
    expect(state.slots.researcher.silentMs).toBe(45000);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 15,
      ts: 1150,
      kind: "slot.rejected",
      role: "researcher",
      agentId: "opus-5",
      rejections: 2,
      findings: [{ claim: "safe", problem: "cve found", severity: "blocker" }],
    });
    expect(state.slots.researcher.state).toBe("rejected");
    expect(state.slots.researcher.rejections).toBe(2);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 16,
      ts: 1160,
      kind: "slot.exhausted",
      role: "researcher",
      reason: "max replacements reached",
      degradedKey: "inv.deps",
    });
    expect(state.slots.researcher.state).toBe("exhausted");
    expect(state.slots.researcher.degradedKey).toBe("inv.deps");
  });

  it("handles approvals, critic verdicts, budget checks, replans, compensations", () => {
    let state = createInitialBoardState();

    state = traceReducer(state, {
      runId: "run-100",
      seq: 17,
      ts: 1170,
      kind: "approval.requested",
      approvalId: "app-1",
      tool: "github_create_issue",
      payload: { title: "Vuln found" },
    });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].status).toBe("pending");

    state = traceReducer(state, {
      runId: "run-100",
      seq: 18,
      ts: 1180,
      kind: "approval.granted",
      approvalId: "app-1",
      decidedBy: "operator",
    });
    expect(state.approvals[0].status).toBe("granted");
    expect(state.approvals[0].decidedBy).toBe("operator");

    state = traceReducer(state, {
      runId: "run-100",
      seq: 19,
      ts: 1190,
      kind: "critic.verdict",
      subtaskId: "s2",
      agentId: "grok",
      verdict: "accepted",
      attempt: 1,
      findings: [],
    });
    expect(state.criticVerdicts).toHaveLength(1);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 20,
      ts: 1200,
      kind: "budget.checked",
      steps: { used: 10, max: 50 },
      usd: { used: 0.5, max: 5 },
      ms: { used: 20000, max: 60000 },
      exceeded: null,
    });
    expect(state.budget.steps.used).toBe(10);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 21,
      ts: 1210,
      kind: "replan.triggered",
      subtaskId: "s3",
      reason: "tool unavailable",
    });
    expect(state.replans).toHaveLength(1);

    state = traceReducer(state, {
      runId: "run-100",
      seq: 22,
      ts: 1220,
      kind: "compensation.ran",
      action: "delete_temp_branch",
      ok: true,
      detail: "Cleaned up",
    });
    expect(state.compensations).toHaveLength(1);
  });

  it("handles the complete takeover sequence: slot.failed -> slot.replacing -> slot.replaced", () => {
    let state = createInitialBoardState();

    // Assign initial researcher
    state = traceReducer(state, {
      runId: "takeover-run",
      seq: 0,
      ts: 1000,
      kind: "slot.assigned",
      role: "researcher",
      agentId: "opus-5",
      provenance: "jev",
      standby: [
        { agentId: "gemini-flash", probability: 0.24 },
        { agentId: "grok", probability: 0.1 },
      ],
    });

    state = traceReducer(state, {
      runId: "takeover-run",
      seq: 1,
      ts: 1010,
      kind: "agent.started",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s3",
      attempt: 1,
    });

    // Researcher is operator killed
    state = traceReducer(state, {
      runId: "takeover-run",
      seq: 2,
      ts: 1020,
      kind: "slot.failed",
      role: "researcher",
      agentId: "opus-5",
      subtaskId: "s3",
      reason: { kind: "operator_kill", detail: "killed from console" },
    });

    expect(state.slots.researcher.state).toBe("failed");
    expect(state.slots.researcher.failureReason?.kind).toBe("operator_kill");

    // Engine replaces slot with standby
    state = traceReducer(state, {
      runId: "takeover-run",
      seq: 3,
      ts: 1030,
      kind: "slot.replacing",
      role: "researcher",
      subtaskId: "s3",
      failedAgentId: "opus-5",
      replacementAgentId: "gemini-flash",
      reason: { kind: "operator_kill", detail: "killed from console" },
      handoff: {
        inputKeys: ["inv.deps", "vulns"],
        cachedResultCount: 5,
        partialNotes: "2 packages checked",
        criticFindings: null,
        budget: { stepsRemaining: 20, usdRemaining: 1.5, msRemaining: 40000 },
      },
      selection: {
        provenance: "standby",
        rank: 1,
        probability: 0.24,
        skipped: [],
      },
      detectionMs: 1800,
    });

    expect(state.run.isTakeoverInProgress).toBe(true);
    expect(state.slots.researcher.state).toBe("replacing");
    expect(state.takeover.active).toBeDefined();
    expect(state.takeover.active?.replacementAgentId).toBe("gemini-flash");
    expect(state.takeover.active?.handoff.cachedResultCount).toBe(5);

    // Replacement starts
    state = traceReducer(state, {
      runId: "takeover-run",
      seq: 4,
      ts: 1040,
      kind: "slot.replaced",
      role: "researcher",
      subtaskId: "s3",
      failedAgentId: "opus-5",
      replacementAgentId: "gemini-flash",
      takeoverMs: 1800,
    });

    expect(state.run.isTakeoverInProgress).toBe(false);
    expect(state.slots.researcher.agentId).toBe("gemini-flash");
    expect(state.slots.researcher.state).toBe("running");
    expect(state.slots.researcher.replaced).toHaveLength(1);
    expect(state.slots.researcher.replaced[0].agentId).toBe("opus-5");
    expect(
      state.slots.researcher.standby.find((s) => s.agentId === "gemini-flash"),
    ).toBeUndefined();
    expect(state.takeover.active?.status).toBe("replaced");
    expect(state.takeover.active?.takeoverMs).toBe(1800);
  });

  it("ensures scrub determinism across the replay engine", () => {
    const events: TraceEvent[] = [
      {
        runId: "det-run",
        seq: 0,
        ts: 1000,
        kind: "run.started",
        task: { repoUrl: "https://github.com/acme/det" },
        mode: "auto",
        budgets: { maxSteps: 10, maxUsd: 1, maxWallClockMs: 10000 },
        chaos: [],
      },
      {
        runId: "det-run",
        seq: 1,
        ts: 1010,
        kind: "slot.assigned",
        role: "researcher",
        agentId: "agent-a",
        provenance: "jev",
        standby: [{ agentId: "agent-b", probability: 0.5 }],
      },
      {
        runId: "det-run",
        seq: 2,
        ts: 1020,
        kind: "agent.started",
        role: "researcher",
        agentId: "agent-a",
        attempt: 1,
      },
      {
        runId: "det-run",
        seq: 3,
        ts: 1030,
        kind: "slot.failed",
        role: "researcher",
        agentId: "agent-a",
        reason: { kind: "operator_kill", detail: "demo kill" },
      },
      {
        runId: "det-run",
        seq: 4,
        ts: 1040,
        kind: "slot.replacing",
        role: "researcher",
        failedAgentId: "agent-a",
        replacementAgentId: "agent-b",
        reason: { kind: "operator_kill", detail: "demo kill" },
        handoff: {
          inputKeys: [],
          cachedResultCount: 2,
          partialNotes: null,
          criticFindings: null,
          budget: { stepsRemaining: 5, usdRemaining: 0.5, msRemaining: 5000 },
        },
        selection: { provenance: "standby", rank: 1, probability: 0.5, skipped: [] },
      },
      {
        runId: "det-run",
        seq: 5,
        ts: 1050,
        kind: "slot.replaced",
        role: "researcher",
        failedAgentId: "agent-a",
        replacementAgentId: "agent-b",
        takeoverMs: 500,
      },
    ];

    const engine = new DeterministicReplayEngine(events);

    // Direct scrub to index 5
    const directState = engine.getStateAt(5);

    // Step-by-step reduction
    const stepState = reduceTrace(events);

    expect(directState.slots.researcher.agentId).toBe(stepState.slots.researcher.agentId);
    expect(directState.slots.researcher.state).toBe(stepState.slots.researcher.state);
    expect(directState.slots.researcher.replaced).toHaveLength(
      stepState.slots.researcher.replaced.length,
    );
    expect(directState.takeover.active?.replacementAgentId).toBe(
      stepState.takeover.active?.replacementAgentId,
    );

    // Backward scrub to index 2
    const backState = engine.getStateAt(2);
    expect(backState.slots.researcher.agentId).toBe("agent-a");
    expect(backState.slots.researcher.state).toBe("running");
    expect(backState.slots.researcher.replaced).toHaveLength(0);

    // Forward scrub again to index 5
    const forwardState = engine.getStateAt(5);
    expect(forwardState.slots.researcher.agentId).toBe("agent-b");
    expect(forwardState.slots.researcher.replaced).toHaveLength(1);
  });
});
