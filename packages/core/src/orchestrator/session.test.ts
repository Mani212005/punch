import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEvent, Config } from "@punch/shared";
import type { ToolExecutor } from "../adapters/anthropic.js";
import { AdapterRegistry } from "../run/registry.js";
import type { Jev, TaskRouting } from "../router/jev.js";
import { scriptedAdapter, type Script } from "../roles/test-helpers.js";
import { OrchestratorSession } from "./session.js";
import {
  ManualRefusalError,
  OrchestratorApprovalError,
  answerApproval,
  consultRouter,
  startRun,
  type ManualSelection,
  type OrchestratorToolDeps,
  type RunStatusReport,
} from "./tools.js";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    version: 1,
    providers: [
      { id: "p-anth", kind: "anthropic", apiKeyEnv: "TEST_KEY" },
      { id: "p-gem", kind: "gemini", apiKeyEnv: "TEST_GEM_KEY" },
    ],
    agents: [
      {
        id: "orch-a",
        displayName: "Orch A",
        providerId: "p-anth",
        model: "claude-opus-5",
        costTier: "medium",
        roles: ["orchestrator"],
        strengths: "talks to users",
      },
      {
        id: "r1",
        displayName: "R1",
        providerId: "p-anth",
        model: "claude-opus-5",
        costTier: "medium",
        roles: ["planner", "researcher", "executor", "critic"],
        strengths: "research",
      },
      {
        id: "r2",
        displayName: "R2",
        providerId: "p-gem",
        model: "gemini-2.5-pro",
        costTier: "low",
        roles: ["planner", "researcher", "executor", "critic"],
        strengths: "backup research",
      },
    ],
    policy: {
      pins: [],
      fallbackChains: [],
      rules: [],
      preferences: "",
      distinctCritic: false,
      autoConfirmBelowConfidence: 0.6,
      maxReplacementsPerSlot: 2,
      stallAfterMs: { api: 45_000, cli: 120_000 },
    },
    budgets: { maxSteps: 20, maxUsd: 5, maxWallClockMs: 120_000 },
    defaults: { mode: "auto", orchestratorAgentId: "orch-a" },
    ...over,
  };
}

function stubJev(): Jev {
  const routing = (roles: string[]): TaskRouting => ({
    difficulty: {
      score: 1,
      levels: 3,
      normalized: 0.5,
      probabilities: [0.1, 0.8, 0.1],
      confidence: 0.9,
    },
    roles: Object.fromEntries(roles.map((role) => [`role_${role}`, undefined])) as never,
    needsExternalData: 0.5,
    isSensitive: 0.5,
    eligible: {} as never,
    model: "stub",
  });
  void routing;
  return {
    async routeTask(input) {
      const roles = input.roles ?? ["planner", "researcher", "executor", "critic"];
      return {
        difficulty: {
          score: 1,
          levels: 3,
          normalized: 0.5,
          probabilities: [0.1, 0.8, 0.1],
          confidence: 0.9,
        },
        roles: Object.fromEntries(
          roles.map((role) => [
            role,
            {
              choice: "r1",
              probabilities: [
                { id: "r1", probability: 0.7 },
                { id: "r2", probability: 0.3 },
              ],
              confidence: 0.9,
            },
          ]),
        ) as never,
        needsExternalData: 0.5,
        isSensitive: 0.5,
        eligible: Object.fromEntries(roles.map((r) => [r, ["r1", "r2"]])) as never,
        model: "stub",
      };
    },
    async routeSubtask() {
      throw new Error("not used");
    },
    async classifyError() {
      return { errorClass: "transient", probabilities: [], confidence: 1 };
    },
    async precheckClaims() {
      return {};
    },
  };
}

interface FakeRun {
  runId: string;
  status: string;
  approvals: Map<string, { approved: boolean; decidedBy: string }>;
}

function makeRunBackend() {
  const runs = new Map<string, FakeRun>();
  let next = 0;
  const approvalsAnswered: { runId: string; approvalId: string; approved: boolean }[] = [];
  return {
    runs,
    approvalsAnswered,
    async createRun(input: {
      repoUrl: string;
      brief?: string;
    }): Promise<{ runId: string; status: string }> {
      next += 1;
      const runId = `run-${next}`;
      runs.set(runId, { runId, status: "running", approvals: new Map() });
      void input;
      return { runId, status: "running" };
    },
    async getRunStatus(runId: string): Promise<RunStatusReport> {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      return { runId, status: run.status, pendingApprovals: [] };
    },
    async answerApproval(input: {
      runId: string;
      approvalId: string;
      approved: boolean;
      decidedBy: string;
      reason?: string;
    }): Promise<{ ok: true }> {
      const run = runs.get(input.runId);
      if (!run) throw new Error(`unknown run ${input.runId}`);
      run.approvals.set(input.approvalId, { approved: input.approved, decidedBy: input.decidedBy });
      approvalsAnswered.push({
        runId: input.runId,
        approvalId: input.approvalId,
        approved: input.approved,
      });
      return { ok: true };
    },
  };
}

function adaptersFor(scripts: Script[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  // The session supplies the engine-tool executor per invocation; forward it
  // so scripts drive the real tool implementations.
  const factory = (ctx: { executeTool: ToolExecutor }) => scriptedAdapter(scripts, ctx.executeTool);
  registry.register("anthropic", factory);
  registry.register("gemini", factory);
  return registry;
}

function toolCallingScript(
  calls: { name: string; input: unknown; callId: string }[],
  reply: string,
): Script {
  return async (_input: AdapterRunInput, exec) => {
    const events: AgentEvent[] = [{ type: "text", text: "Working on it." }];
    for (const call of calls) {
      events.push({ type: "tool_call", callId: call.callId, tool: call.name, input: call.input });
      try {
        const output = await exec(call.name, call.input, call.callId);
        events.push({
          type: "tool_result",
          callId: call.callId,
          tool: call.name,
          ok: true,
          output,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        events.push({
          type: "tool_result",
          callId: call.callId,
          tool: call.name,
          ok: false,
          output: message,
        });
        throw err;
      }
    }
    events.push({ type: "result", output: { reply } });
    events.push({ type: "done", status: "ok" });
    return events;
  };
}

describe("orchestrator tools", () => {
  function deps(over: Partial<OrchestratorToolDeps> = {}): OrchestratorToolDeps {
    const backend = makeRunBackend();
    return {
      config: makeConfig(),
      mode: "auto",
      jev: stubJev(),
      getManualSelections: () => [],
      startRun: (input) => backend.createRun(input),
      getRunStatus: (runId) => backend.getRunStatus(runId),
      answerApproval: (input) => backend.answerApproval(input),
      ...over,
    };
  }

  it("consult_router returns assignments with standby, probabilities, confidence, difficulty, provenance", async () => {
    const plan = await consultRouter(deps(), { brief: "triage https://github.com/x/y" });
    expect(plan.difficulty).toBe("moderate");
    expect(plan.assignments.length).toBeGreaterThan(0);
    for (const a of plan.assignments) {
      expect(a.agentId).toBe("r1");
      expect(a.provenance).toBe("jev");
      expect(a.confidence).toBe(0.9);
      expect(a.probabilities).toEqual([
        { agentId: "r1", probability: 0.7 },
        { agentId: "r2", probability: 0.3 },
      ]);
      expect(a.standby).toEqual([{ agentId: "r2", probability: 0.3 }]);
    }
  });

  it("start_run refuses assignments that differ from the manual selection in manual mode", async () => {
    const manual: ManualSelection[] = [{ role: "researcher", agentId: "r1" }];
    const d = deps({ mode: "manual", getManualSelections: () => manual });
    await expect(
      startRun(d, {
        repoUrl: "https://github.com/x/y",
        assignments: [{ role: "researcher", agentId: "r2" }],
      }),
    ).rejects.toBeInstanceOf(ManualRefusalError);
    const receipt = await startRun(d, {
      repoUrl: "https://github.com/x/y",
      assignments: [{ role: "researcher", agentId: "r1" }],
    });
    expect(receipt.runId).toMatch(/^run-/);
  });

  it("answer_approval relays the human decision and refuses to decide", async () => {
    const backend = makeRunBackend();
    const created = await backend.createRun({ repoUrl: "https://github.com/x/y" });
    const d = deps({
      startRun: (input) => backend.createRun(input),
      getRunStatus: (runId) => backend.getRunStatus(runId),
      answerApproval: (input) => backend.answerApproval(input),
    });
    await answerApproval(d, {
      runId: created.runId,
      approvalId: "appr-1",
      decision: "approve",
      decidedBy: "human:console",
    });
    expect(backend.approvalsAnswered).toEqual([
      { runId: created.runId, approvalId: "appr-1", approved: true },
    ]);
    await expect(
      answerApproval(d, {
        runId: created.runId,
        approvalId: "appr-2",
        decision: "deny",
        decidedBy: "orchestrator",
      }),
    ).rejects.toBeInstanceOf(OrchestratorApprovalError);
  });
});

describe("orchestrator session", () => {
  it("auto mode: consults the router, starts the run, and narrates", async () => {
    const backend = makeRunBackend();
    const config = makeConfig();
    const narrations: string[] = [];
    // The script drives the real engine tools through the session's executor.
    const capture: Script = (input, exec) =>
      toolCallingScript(
        [
          {
            name: "consult_router",
            input: { brief: "triage https://github.com/x/y" },
            callId: "c1",
          },
          { name: "start_run", input: { repoUrl: "https://github.com/x/y" }, callId: "c2" },
        ],
        "Started run-1; watching it now.",
      )(input, exec);
    const session = new OrchestratorSession({
      sessionId: "sess-1",
      config,
      mode: "auto",
      orchestratorAgentId: "orch-a",
      jev: stubJev(),
      adapters: adaptersFor([capture]),
      createRun: (input) => backend.createRun(input),
      getRunStatus: (runId) => backend.getRunStatus(runId),
      answerApproval: (input) => backend.answerApproval(input),
      onNarration: (n) => {
        narrations.push(`${n.kind}:${n.text}`);
      },
    });
    const reply = await session.handleUserMessage("triage https://github.com/x/y");
    expect(reply).toMatch(/run-1/);
    expect(session.runIds).toEqual(["run-1"]);
    expect(narrations.some((n) => n.startsWith("tool_call:start_run"))).toBe(true);
    expect(session.transcript).toHaveLength(2);
  });

  it("manual mode: narrates the refusal when assignments differ", async () => {
    const backend = makeRunBackend();
    const config = makeConfig();
    const kinds: string[] = [];
    const session = new OrchestratorSession({
      sessionId: "sess-manual",
      config,
      mode: "manual",
      orchestratorAgentId: "orch-a",
      jev: stubJev(),
      adapters: adaptersFor([
        toolCallingScript(
          [
            {
              name: "start_run",
              input: {
                repoUrl: "https://github.com/x/y",
                assignments: [{ role: "researcher", agentId: "r2" }],
              },
              callId: "c1",
            },
          ],
          "unreached",
        ),
      ]),
      createRun: (input) => backend.createRun(input),
      getRunStatus: (runId) => backend.getRunStatus(runId),
      answerApproval: (input) => backend.answerApproval(input),
      manualSelections: [{ role: "researcher", agentId: "r1" }],
      onNarration: (n) => {
        kinds.push(n.kind);
      },
    });
    const reply = await session.handleUserMessage("start with r2");
    expect(reply).toMatch(/continues|problem/i);
    expect(kinds).toContain("failure");
    expect(session.runIds).toEqual([]);
    expect(backend.runs.size).toBe(0);
  });

  it("orchestrator failure mid-run leaves the run continuing", async () => {
    const backend = makeRunBackend();
    const config = makeConfig();
    const kinds: string[] = [];
    const failing: Script = async (_input, exec) => {
      const output = await exec("start_run", { repoUrl: "https://github.com/x/y" }, "c1");
      const runId = (output as { runId: string }).runId;
      // The run continues on its own after the orchestrator dies.
      void backend.getRunStatus(runId).then(() => {
        backend.runs.get(runId)!.status = "completed";
      });
      return [
        { type: "text", text: `Launched ${runId}, then crashing.` },
        { type: "done", status: "error", error: "boom: adapter crashed mid-run" },
      ];
    };
    const session = new OrchestratorSession({
      sessionId: "sess-crash",
      config,
      mode: "auto",
      orchestratorAgentId: "orch-a",
      jev: stubJev(),
      adapters: adaptersFor([failing]),
      createRun: (input) => backend.createRun(input),
      getRunStatus: (runId) => backend.getRunStatus(runId),
      answerApproval: (input) => backend.answerApproval(input),
      onNarration: (n) => {
        kinds.push(n.kind);
      },
    });
    const reply = await session.handleUserMessage("go");
    expect(reply).toMatch(/continues/);
    expect(kinds).toContain("failure");
    expect(session.runIds).toHaveLength(1);
    const runId = session.runIds[0]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await backend.getRunStatus(runId);
    expect(status.status).toBe("completed");
  });

  it("rejects a non-tool-calling orchestrator agent", async () => {
    const config = makeConfig({
      providers: [{ id: "p-cli", kind: "claude-code" }],
      agents: [
        {
          id: "orch-cli",
          displayName: "CLI",
          providerId: "p-cli",
          model: "claude-code",
          costTier: "low",
          roles: ["orchestrator"],
          strengths: "cli",
        },
      ],
      defaults: { mode: "auto", orchestratorAgentId: "orch-cli" },
    });
    const session = new OrchestratorSession({
      sessionId: "sess-cli",
      config,
      mode: "auto",
      orchestratorAgentId: "orch-cli",
      jev: stubJev(),
      adapters: new AdapterRegistry(),
      createRun: () => Promise.resolve({ runId: "run-x", status: "running" }),
      getRunStatus: () =>
        Promise.resolve({ runId: "run-x", status: "running", pendingApprovals: [] }),
      answerApproval: () => Promise.resolve({ ok: true as const }),
    });
    const reply = await session.handleUserMessage("hi");
    expect(reply).toMatch(/cannot call tools|problem/i);
  });
});
