import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceEvent as TraceEventSchema, type AgentAdapter, type TraceEvent } from "@punch/shared";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureRunOptions, loadRunFixture, type RunFixture } from "../run/fixture.js";
import { runLoop, type RunHandle, type RunLoopOptions, type RunResult } from "../run/loop.js";
import { AdapterRegistry } from "../run/registry.js";
import { parseTrace } from "../trace/writer.js";
import { requestKill } from "./control.js";

const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../fixtures/runs/takeover",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-takeover-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

async function run(
  extra: Partial<RunLoopOptions> = {},
  edit: (fixture: RunFixture) => void = () => {},
): Promise<RunResult> {
  const fixture = await loadRunFixture(FIXTURE);
  edit(fixture);
  return runLoop(
    fixtureRunOptions(fixture, {
      runsDir,
      toolTimeoutMs: 500,
      maxConcurrency: 1,
      killChannel: false,
      ...extra,
    }),
  );
}

type Of<K extends TraceEvent["kind"]> = Extract<TraceEvent, { kind: K }>;
const of = <K extends TraceEvent["kind"]>(r: RunResult, kind: K): Of<K>[] =>
  r.events.filter((e): e is Of<K> => e.kind === kind);
const kinds = (r: RunResult) => r.events.map((e) => e.kind);

function expectWellFormed(r: RunResult): void {
  expect(r.traceErrors).toEqual([]);
  expect(kinds(r).at(-1)).toBe("run.finished");
  expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
  for (const e of r.events) expect(TraceEventSchema.safeParse(e).success).toBe(true);
}

/** The three takeover events for one role, in order, with `slot.failed` first. */
function takeoverOf(r: RunResult, role: string, subtaskId?: string) {
  const match = <E extends { role: string; subtaskId?: string | undefined }>(e: E) =>
    e.role === role && (subtaskId === undefined || e.subtaskId === subtaskId);
  const failed = of(r, "slot.failed").find(match);
  const rejected = of(r, "slot.rejected").find(match);
  const replacing = of(r, "slot.replacing").find(match);
  const replaced = of(r, "slot.replaced").find(match);
  expect(failed ?? rejected, "slot.failed or slot.rejected").toBeDefined();
  expect(replacing, "slot.replacing").toBeDefined();
  expect(replaced, "slot.replaced").toBeDefined();
  const at = (e: TraceEvent) => r.events.indexOf(e);
  expect(at((failed ?? rejected)!)).toBeLessThan(at(replacing!));
  expect(at(replacing!)).toBeLessThan(at(replaced!));
  return { failed: failed!, rejected, replacing: replacing!, replaced: replaced! };
}

/**
 * The replacement received the predecessor's files, evidence and cached tool results and did not
 * redo them: its first calls for the subtask come back from the cache.
 */
function expectResumed(r: RunResult, subtaskId: string): void {
  const { replacing, replaced } = takeoverOf(r, "researcher", subtaskId);
  const h = replacing.handoff;
  expect(h.cachedResultCount).toBeGreaterThan(0);
  expect(h.filesInspectedCount).toBeGreaterThan(0);
  expect(h.evidenceRecordCount).toBeGreaterThan(0);
  const after = r.events.slice(r.events.indexOf(replaced) + 1);
  const results = after.filter(
    (e): e is Of<"tool.result"> =>
      e.kind === "tool.result" && e.callId.startsWith(`${subtaskId}-c`),
  );
  expect(results.length).toBeGreaterThanOrEqual(h.cachedResultCount);
  for (const res of results.slice(0, h.cachedResultCount)) expect(res.cached).toBe(true);
  const started = after.find(
    (e): e is Of<"agent.started"> => e.kind === "agent.started" && e.subtaskId === subtaskId,
  );
  expect(started?.agentId).toBe(replaced.replacementAgentId);
  const said = after.find(
    (e): e is Of<"agent.text"> => e.kind === "agent.text" && e.text.startsWith("Taking over"),
  );
  expect(said?.text).toContain(`${h.cachedResultCount} cached tool results`);
}

/**
 * Kills the researcher the instant the given tool call has returned to it. Done inside the agent's
 * own event stream: the trace subscriber lags the agent, so it cannot land a kill mid-subtask.
 */
function killAfterCall(
  fixture: RunFixture,
  callId: string,
  detail?: string,
): Partial<RunLoopOptions> {
  let handle: RunHandle | undefined;
  let done = false;
  const inner = fixtureRunOptions(fixture).adapters;
  const adapters = new AdapterRegistry();
  for (const kind of inner.kinds()) {
    adapters.register(kind, (ctx) => {
      const adapter = inner.create(ctx);
      return {
        capabilities: adapter.capabilities,
        test: () => adapter.test(),
        async *run(input) {
          for await (const event of adapter.run(input)) {
            yield event;
            if (!done && event.type === "tool_result" && event.callId === callId) {
              done = true;
              handle!.kill("researcher", detail);
            }
          }
        },
      } satisfies AgentAdapter;
    });
  }
  return { adapters, onReady: (h) => (handle = h) };
}

describe("manual kill mid-subtask", () => {
  it("fails, replaces and finishes the subtask on the replacement with cached results", async () => {
    const fixture = await loadRunFixture(FIXTURE);
    const r = await run(killAfterCall(fixture, "s1-c2", "killed from the test"));
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    const { failed, replacing, replaced } = takeoverOf(r, "researcher", "s1");
    expect(failed.agentId).toBe("opus");
    expect(failed.reason).toEqual({ kind: "operator_kill", detail: "killed from the test" });
    expect(replacing.failedAgentId).toBe("opus");
    expect(replacing.replacementAgentId).toBe("gemini");
    expect(replacing.selection).toMatchObject({ provenance: "standby", rank: 1 });
    expect(replaced.replacementAgentId).toBe("gemini");
    expect(replaced.takeoverMs).toBeLessThan(3000);
    expect(replacing.handoff).toMatchObject({
      cachedResultCount: 2,
      filesInspectedCount: 2,
      evidenceRecordCount: 2,
    });
    expect(replacing.handoff.budget.stepsRemaining).toBeGreaterThan(0);
    expectResumed(r, "s1");

    // the same output key, written by the replacement, accepted by the critic
    const entry = r.blackboard["inventory"]!;
    expect(entry.status).toBe("ok");
    expect(entry.writtenBy.agentId).toBe("gemini");
    expect(of(r, "critic.verdict").every((v) => v.verdict === "accepted")).toBe(true);

    const researcher = r.slots.find((s) => s.role === "researcher")!;
    expect(researcher.agentId).toBe("gemini");
    expect(researcher.replaced).toMatchObject([
      { agentId: "opus", reason: { kind: "operator_kill" } },
    ]);
    // the replacement was started with a higher effort than the killed attempt
    const starts = of(r, "agent.started").filter(
      (e) => e.subtaskId === "s1" && e.role === "researcher",
    );
    expect(starts.map((e) => e.agentId)).toEqual(["opus", "gemini"]);
    expect(starts[1]!.effort).toBe("high");
  });

  it("kills a slot with nothing running: reports false", async () => {
    let handle: RunHandle | undefined;
    await run({ onReady: (h) => (handle = h) });
    expect(handle!.kill("researcher")).toBe(false);
  });

  it("`punch kill` reaches a run through the control directory", async () => {
    let requested = false;
    const r = await run({
      killChannel: true,
      onEvent: (e) => {
        if (!requested && e.kind === "agent.started" && e.role === "researcher") {
          requested = true;
          requestKill(runsDir, e.runId, "researcher", "punch kill");
        }
      },
      chaos: ["stall:researcher"],
    });
    expectWellFormed(r);
    const { failed } = takeoverOf(r, "researcher");
    expect(failed.reason).toEqual({ kind: "operator_kill", detail: "punch kill" });
    expect(r.status).toBe("completed");
  });

  it("requestKill refuses an unknown run", () => {
    expect(() => requestKill(runsDir, "no-such-run", "researcher")).toThrow(/no run/);
  });

  it("kills concurrent subtasks on one slot with a single replacement", async () => {
    const fixture = await loadRunFixture(FIXTURE);
    const r = await run({ ...killAfterCall(fixture, "s2-c1"), maxConcurrency: 4 });
    expectWellFormed(r);
    expect(r.status).toBe("completed");
    expect(of(r, "slot.replaced").filter((e) => e.role === "researcher")).toHaveLength(1);
    expect(r.slots.find((s) => s.role === "researcher")!.replaced).toHaveLength(1);
  });
});

describe("the eight failure modes each recover with the handoff", () => {
  it("agent crash (kill-after)", async () => {
    const r = await run({ chaos: ["kill-after:researcher:2"] });
    expectWellFormed(r);
    const { failed } = takeoverOf(r, "researcher", "s1");
    expect(failed.reason.detail).toMatch(/crashed/);
    expectResumed(r, "s1");
    expect(r.status).toBe("completed");
  });

  it("timeout: the agent keeps emitting but never finishes", async () => {
    const r = await run(
      {
        chaos: ["timeout:researcher"],
        attemptTimeoutMs: 120,
        nudgeGraceMs: 20,
        stallCheckIntervalMs: 10,
      },
      (f) => {
        f.config.policy.stallAfterMs = { api: 60_000, cli: 120_000 };
      },
    );
    expectWellFormed(r);
    const { failed, replacing } = takeoverOf(r, "researcher", "s1");
    expect(failed.reason.kind).toBe("failed");
    expect(failed.reason.detail).toMatch(/no result after/);
    expect(replacing.detectionMs).toBeGreaterThanOrEqual(0);
    expect(of(r, "slot.stalled")).toHaveLength(0);
    expect(r.status).toBe("completed");
  });

  it("malformed output (garbage) fails after one retry and is replaced", async () => {
    const r = await run({ chaos: ["garbage:researcher"] });
    expectWellFormed(r);
    const { failed } = takeoverOf(r, "researcher", "s1");
    expect(failed.classification).toBe("malformed");
    expect(
      of(r, "agent.started").filter((e) => e.subtaskId === "s1" && e.agentId === "opus"),
    ).toHaveLength(2);
    expectResumed(r, "s1");
    expect(r.status).toBe("completed");
  });

  it("hallucinated claim: the critic refutes it and the rejected slot is replaced", async () => {
    const r = await run({ chaos: ["hallucinate:researcher"] });
    expectWellFormed(r);
    const rejected = of(r, "slot.rejected").find((e) => e.subtaskId === "s1")!;
    expect(
      rejected.findings.some((f) => /Jev pre-check|does not exist in the trace/.test(f.problem)),
    ).toBe(true);
    const { replacing } = takeoverOf(r, "researcher", "s1");
    expect(replacing.reason.kind).toBe("rejected");
    expect(replacing.handoff.criticFindings?.length).toBeGreaterThan(0);
    expectResumed(r, "s1");
    expect(r.blackboard["inventory"]!.writtenBy.agentId).not.toBe("opus");
    expect(r.status).toBe("completed");
  });

  it("tool failure is absorbed by the recovery ladder, not by takeover", async () => {
    const r = await run({ chaos: ["tool:osv_query:500"] });
    expectWellFormed(r);
    expect(of(r, "slot.failed")).toHaveLength(0);
    expect(of(r, "slot.replacing")).toHaveLength(0);
    expect(r.blackboard["vulns"]!.status).toBe("degraded");
  });

  it("rate limit: retried, then the provider is marked down and the standby is on another provider", async () => {
    const r = await run({ chaos: ["rate-limit:anthropic"] });
    expectWellFormed(r);
    const { failed, replacing } = takeoverOf(r, "planner");
    expect(failed.reason.detail).toMatch(/429/);
    expect(replacing.replacementAgentId).toBe("gemini");
    expect(replacing.selection.skipped).toContainEqual({
      agentId: "sonnet",
      reason: "provider anthropic is down",
    });
    expect(r.status).toBe("completed");
  });

  it("critic rejection picks an equal or higher cost tier", async () => {
    const r = await run({}, (f) => {
      // sonnet (medium) researches; gemini (low) is first in line but a lower tier
      const role = f.jev.routeTask as { answers: Record<string, { probabilities: unknown }> };
      role.answers["role_researcher"] = {
        type: "choice",
        choice: "sonnet",
        confidence: 0.6,
        probabilities: { sonnet: 0.6, gemini: 0.25, opus: 0.15 },
      } as never;
      f.agents.critic = {
        reject: { s1: [{ claim: "inventory", problem: "not supported", severity: "blocker" }] },
        rejectProducers: ["sonnet"],
      };
    });
    expectWellFormed(r);
    const { replacing } = takeoverOf(r, "researcher", "s1");
    expect(replacing.reason.kind).toBe("rejected");
    expect(replacing.failedAgentId).toBe("sonnet");
    expect(replacing.replacementAgentId).toBe("opus");
    expect(replacing.selection.skipped).toContainEqual({
      agentId: "gemini",
      reason: "lower cost tier than the rejected agent",
    });
    expect(replacing.handoff.criticFindings).toHaveLength(1);
    expect(of(r, "slot.rejected")[0]!.rejections).toBe(2);
    expect(r.blackboard["inventory"]!.writtenBy.agentId).toBe("opus");
    expect(r.status).toBe("completed");
  });
});

describe("stall detection", () => {
  it("triggers after the configured silence: nudge, then takeover", async () => {
    const r = await run(
      { chaos: ["stall:researcher"], nudgeGraceMs: 40, stallCheckIntervalMs: 10 },
      (f) => {
        f.config.policy.stallAfterMs = { api: 100, cli: 120_000 };
      },
    );
    expectWellFormed(r);
    const stalled = of(r, "slot.stalled")[0]!;
    expect(stalled).toMatchObject({ role: "researcher", agentId: "opus", nudged: true });
    expect(stalled.silentMs).toBeGreaterThanOrEqual(100);
    expect(stalled.silentMs).toBeLessThan(1000);
    const { failed, replacing } = takeoverOf(r, "researcher", "s1");
    expect(failed.reason.kind).toBe("stalled");
    expect(r.events.indexOf(stalled)).toBeLessThan(r.events.indexOf(failed));
    expect(replacing.detectionMs).toBeGreaterThanOrEqual(100);
    expect(r.status).toBe("completed");
  });
});

describe("provider-down", () => {
  it("skips same-provider standbys and completes on the other provider", async () => {
    const r = await run({ chaos: ["provider-down:anthropic"] });
    expectWellFormed(r);
    const planner = takeoverOf(r, "planner");
    expect(planner.replacing.replacementAgentId).toBe("gemini");
    expect(planner.replacing.selection.skipped).toContainEqual({
      agentId: "sonnet",
      reason: "provider anthropic is down",
    });
    // no anthropic agent is ever chosen as a replacement afterwards
    for (const e of of(r, "slot.replacing")) expect(e.replacementAgentId).toBe("gemini");
    // later anthropic slots are replaced without spending attempts on the dead provider
    const executor = of(r, "slot.failed").find((e) => e.role === "executor")!;
    expect(executor.reason.detail).toMatch(/provider anthropic is down/);
    expect(r.status).toBe("completed");
  });
});

/** Every researcher agent crashes, whoever it is. */
function crashingResearchers(fixture: RunFixture): AdapterRegistry {
  const inner = fixtureRunOptions(fixture).adapters;
  const registry = new AdapterRegistry();
  for (const kind of inner.kinds()) {
    registry.register(kind, (ctx) => {
      const adapter = inner.create(ctx);
      return {
        capabilities: adapter.capabilities,
        test: () => adapter.test(),
        run: (input) => {
          if (input.role === "researcher") throw new Error("agent process crashed");
          return adapter.run(input);
        },
      } satisfies AgentAdapter;
    });
  }
  return registry;
}

describe("limits", () => {
  it("two replacements, then slot.exhausted, a degraded key and a run that continues", async () => {
    const fixture = await loadRunFixture(FIXTURE);
    const r = await runLoop(
      fixtureRunOptions(fixture, {
        runsDir,
        toolTimeoutMs: 500,
        maxConcurrency: 1,
        killChannel: false,
        maxFailureReplans: 0,
        adapters: crashingResearchers(fixture),
      }),
    );
    expectWellFormed(r);
    const s1 = <E extends { subtaskId?: string | undefined }>(e: E) => e.subtaskId === "s1";
    expect(of(r, "slot.failed").filter(s1)).toHaveLength(3);
    expect(
      of(r, "slot.replacing")
        .filter(s1)
        .map((e) => e.replacementAgentId),
    ).toEqual(["gemini", "sonnet"]);
    expect(of(r, "slot.replaced").filter(s1)).toHaveLength(2);
    const exhausted = of(r, "slot.exhausted").filter(s1);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ role: "researcher", degradedKey: "inventory" });
    expect(r.events.indexOf(exhausted[0]!)).toBeGreaterThan(
      r.events.indexOf(of(r, "slot.replaced").filter(s1)[1]!),
    );
    expect(r.blackboard["inventory"]!.status).toBe("degraded");
    expect(r.slots.find((s) => s.role === "researcher")!.state).toMatch(/degraded|running|failed/);
    // the run continued to a report
    expect(r.reportKey).toBe("report");
    expect(r.status).toBe("degraded");
  });

  it("no eligible replacement is exhaustion too", async () => {
    const r = await run(
      { chaos: ["provider-down:anthropic", "provider-down:google"], maxFailureReplans: 0 },
      () => {},
    );
    expectWellFormed(r);
    expect(of(r, "slot.exhausted").length).toBeGreaterThan(0);
    expect(r.status).toBe("failed");
  });
});

describe("the committed takeover trace", () => {
  const traceFile = path.resolve(
    fileURLToPath(import.meta.url),
    "../../../../../traces/takeover.jsonl",
  );

  it("is a valid recorded run with the exact takeover sequence and matches the web copy", () => {
    const events = parseTrace(fs.readFileSync(traceFile, "utf-8"));
    for (const e of events) expect(TraceEventSchema.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)).toMatchObject({ kind: "run.finished", status: "completed" });
    const seq = events
      .filter(
        (e) =>
          e.kind === "slot.failed" || e.kind === "slot.replacing" || e.kind === "slot.replaced",
      )
      .map((e) => e.kind);
    expect(seq).toEqual(["slot.failed", "slot.replacing", "slot.replaced"]);
    const replacing = events.find((e): e is Of<"slot.replacing"> => e.kind === "slot.replacing")!;
    expect(replacing.handoff.cachedResultCount).toBeGreaterThan(0);
    const webCopy = path.resolve(traceFile, "../../apps/web/public/traces/takeover.jsonl");
    expect(fs.readFileSync(webCopy, "utf-8")).toBe(fs.readFileSync(traceFile, "utf-8"));
  });
});
