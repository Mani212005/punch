import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceEvent as TraceEventSchema, type AgentAdapter, type TraceEvent } from "@punch/shared";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureRunOptions, loadRunFixture, type RunFixture } from "../run/fixture.js";
import { runLoop, type RunHandle, type RunLoopOptions, type RunResult } from "../run/loop.js";
import { AdapterRegistry } from "../run/registry.js";

/**
 * B3 cross-provider takeover and B4 per-subtask effort routing (plan.md 5).
 *
 * The fixture ships with Anthropic + Gemini agents; these tests add a CLI standby
 * (opencode kind) so takeovers can land on a third provider kind. A9's takeover.test.ts
 * covers the same-provider and Gemini paths; this file owns the cross-provider contract:
 * killing an Anthropic researcher must finish on a non-Anthropic standby, and
 * `provider-down:anthropic` must route every affected slot away from Anthropic.
 */
const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../fixtures/runs/takeover",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-cross-provider-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

const CLI_AGENT_ID = "opencode";

/** The fixture plus a CLI provider and standby agent on a third provider kind. */
async function loadCliFixture(edit: (fixture: RunFixture) => void = () => {}): Promise<RunFixture> {
  const fixture = await loadRunFixture(FIXTURE);
  fixture.config.providers.push({ id: "opencode-local", kind: "opencode" });
  fixture.config.agents.push({
    id: CLI_AGENT_ID,
    displayName: "OpenCode",
    providerId: "opencode-local",
    model: "opencode",
    costTier: "low",
    roles: ["planner", "researcher", "executor", "critic"],
    strengths: "Local CLI standby for takeover",
  });
  edit(fixture);
  return fixture;
}

function providerOf(fixture: RunFixture, agentId: string): string {
  return fixture.config.agents.find((a) => a.id === agentId)?.providerId ?? "unknown";
}

async function runFixture(
  fixture: RunFixture,
  extra: Partial<RunLoopOptions> = {},
): Promise<RunResult> {
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

function expectWellFormed(r: RunResult): void {
  expect(r.traceErrors).toEqual([]);
  expect(r.events.map((e) => e.kind).at(-1)).toBe("run.finished");
  expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
  for (const e of r.events) expect(TraceEventSchema.safeParse(e).success).toBe(true);
}

/**
 * Kills the researcher the instant the given tool call has returned to it. Done inside the
 * agent's own event stream: the trace subscriber lags the agent, so it cannot land a kill
 * mid-subtask.
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

describe("B3 cross-provider takeover", () => {
  it("kill an Anthropic researcher mid-subtask: a non-Anthropic standby finishes it", async () => {
    const fixture = await loadCliFixture();
    const r = await runFixture(fixture, killAfterCall(fixture, "s1-c2", "killed from the test"));
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    const failed = of(r, "slot.failed").find((e) => e.subtaskId === "s1")!;
    const replacing = of(r, "slot.replacing").find((e) => e.subtaskId === "s1")!;
    const replaced = of(r, "slot.replaced").find((e) => e.subtaskId === "s1")!;
    expect(failed.agentId).toBe("opus");
    expect(providerOf(fixture, failed.agentId)).toBe("anthropic");
    expect(failed.reason).toEqual({ kind: "operator_kill", detail: "killed from the test" });
    expect(providerOf(fixture, replacing.replacementAgentId)).not.toBe("anthropic");
    expect(replaced.replacementAgentId).toBe(replacing.replacementAgentId);
    expect(replaced.takeoverMs).toBeLessThan(3000);

    // The handoff carried the predecessor's work; the replacement did not redo it.
    expect(replacing.handoff.cachedResultCount).toBeGreaterThan(0);
    expect(replacing.handoff.filesInspectedCount).toBeGreaterThan(0);
    expect(replacing.handoff.evidenceRecordCount).toBeGreaterThan(0);
    const after = r.events.slice(r.events.indexOf(replaced) + 1);
    const cached = after.filter(
      (e): e is Of<"tool.result"> =>
        e.kind === "tool.result" && e.callId.startsWith("s1-c") && e.cached === true,
    );
    expect(cached.length).toBeGreaterThanOrEqual(replacing.handoff.cachedResultCount);

    // The same output key, written by the non-Anthropic replacement.
    expect(r.blackboard["inventory"]!.writtenBy.agentId).toBe(replacing.replacementAgentId);
    expect(providerOf(fixture, r.blackboard["inventory"]!.writtenBy.agentId)).not.toBe("anthropic");
  });

  it("provider-down:anthropic routes every affected slot to a non-Anthropic standby", async () => {
    const fixture = await loadCliFixture();
    const r = await runFixture(fixture, { chaos: ["provider-down:anthropic"] });
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    const replacing = of(r, "slot.replacing");
    expect(replacing.length).toBeGreaterThan(0);
    for (const e of replacing) {
      expect(providerOf(fixture, e.failedAgentId)).toBe("anthropic");
      expect(providerOf(fixture, e.replacementAgentId)).not.toBe("anthropic");
    }
    // Same-provider standbys were skipped for the dead provider, not retried.
    const skippedAnthropic = replacing
      .flatMap((e) => e.selection.skipped)
      .filter((s) => s.reason.includes("provider anthropic is down"));
    expect(skippedAnthropic.length).toBeGreaterThan(0);
  });

  it("a CLI standby finishes the subtask; its effort is not bumped", async () => {
    const fixture = await loadCliFixture((f) => {
      f.config.policy.fallbackChains = [{ role: "researcher", agentIds: [CLI_AGENT_ID] }];
    });
    const r = await runFixture(fixture, killAfterCall(fixture, "s1-c2", "killed from the test"));
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    const replacing = of(r, "slot.replacing").find((e) => e.subtaskId === "s1")!;
    expect(replacing.replacementAgentId).toBe(CLI_AGENT_ID);
    expect(replacing.selection).toMatchObject({ provenance: "chain" });
    expect(r.blackboard["inventory"]!.writtenBy.agentId).toBe(CLI_AGENT_ID);

    // The CLI adapter does not support effort, so the replacement keeps the failed
    // attempt's level instead of being bumped one up (plan.md 2.3).
    const starts = of(r, "agent.started").filter(
      (e) => e.subtaskId === "s1" && e.role === "researcher",
    );
    expect(starts.map((e) => e.agentId)).toEqual(["opus", CLI_AGENT_ID]);
    expect(starts[0]!.effort).toBe("medium");
    expect(starts[1]!.effort).toBe("medium");
  });

  it("an opaque CLI crash hands over inputs and notes but no tool results", async () => {
    const fixture = await loadCliFixture((f) => {
      f.config.policy.pins = [{ role: "researcher", agentId: CLI_AGENT_ID }];
    });
    const inner = fixtureRunOptions(fixture).adapters;
    const adapters = new AdapterRegistry();
    for (const kind of inner.kinds()) {
      adapters.register(kind, (ctx) => {
        const adapter = inner.create(ctx);
        if (ctx.agent.id !== CLI_AGENT_ID) return adapter;
        // A CLI agent's internal tool calls are opaque: text and opaque output only,
        // then a crash, so the handoff has notes but zero cached tool results.
        return {
          capabilities: adapter.capabilities,
          test: () => adapter.test(),
          async *run() {
            yield { type: "text", text: "Reading the repo with my own tools." };
            yield { type: "opaque_output", text: '{"tool":"read","file":"package.json"}' };
            throw new Error("agent process crashed");
          },
        } satisfies AgentAdapter;
      });
    }
    const r = await runFixture(fixture, {
      adapters,
      // Anthropic is down too, so the standby cannot fall back to rank 1 (opus):
      // the opaque CLI crash must be finished by Gemini with no cached results.
      chaos: ["provider-down:anthropic"],
    });
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    const replacing = of(r, "slot.replacing").find((e) => e.subtaskId === "s1")!;
    expect(replacing.failedAgentId).toBe(CLI_AGENT_ID);
    expect(providerOf(fixture, replacing.replacementAgentId)).not.toBe("anthropic");
    expect(replacing.handoff.cachedResultCount).toBe(0);
    expect(replacing.handoff.filesInspectedCount).toBe(0);
    expect(replacing.handoff.evidenceRecordCount).toBe(0);
    expect(replacing.handoff.partialNotes).toContain("Reading the repo");

    const after = r.events.slice(
      r.events.indexOf(of(r, "slot.replaced").find((e) => e.subtaskId === "s1")!) + 1,
    );
    const said = after.find(
      (e): e is Of<"agent.text"> =>
        e.kind === "agent.text" &&
        e.text.includes("Taking over s1") &&
        e.text.includes("no cached results (previous agent used its own tools)"),
    );
    expect(said, "replacement reports no cached results").toBeDefined();
    expect(r.blackboard["inventory"]!.writtenBy.agentId).toBe(replacing.replacementAgentId);
  });
});

describe("B4 per-subtask effort routing", () => {
  it("complexity sets effort per subtask in the plan and in agent.started trace events", async () => {
    const fixture = await loadCliFixture();
    const r = await runFixture(fixture);
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    // Fixture complexities: default score 0.7 (normalized 0.35 -> medium),
    // "Write remediation report" score 1.4 (normalized 0.7 -> high).
    expect(r.plan!.subtasks.find((s) => s.id === "s1")).toMatchObject({ effort: "medium" });
    expect(r.plan!.subtasks.find((s) => s.id === "s4")).toMatchObject({ effort: "high" });

    const started = (subtaskId: string) =>
      of(r, "agent.started").find((e) => e.subtaskId === subtaskId);
    expect(started("s1")).toMatchObject({ effort: "medium" });
    expect(started("s4")).toMatchObject({ effort: "high" });
    expect(of(r, "route.decided").find((e) => e.subtaskId === "s1")!.confidence).toBeGreaterThan(0);
  });

  it("takeover bumps the replacement effort one level in the trace", async () => {
    const fixture = await loadCliFixture();
    const r = await runFixture(fixture, killAfterCall(fixture, "s1-c2", "killed from the test"));
    expectWellFormed(r);

    const starts = of(r, "agent.started").filter(
      (e) => e.subtaskId === "s1" && e.role === "researcher",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ agentId: "opus", effort: "medium" });
    expect(starts[1]).toMatchObject({ effort: "high" });
  });
});
