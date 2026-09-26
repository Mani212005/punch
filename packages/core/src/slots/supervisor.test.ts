import type { Config, TraceEvent } from "@punch/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slot, type EventBody } from "../run/slot.js";
import { AttemptLog } from "./handoff.js";
import { chaosAdapter, parseSlotChaos } from "./chaos.js";
import { AttemptAborted, SlotSupervisor } from "./supervisor.js";

const roles = ["planner", "researcher", "executor", "critic"] as const;
const agent = (id: string, providerId: string, costTier: "low" | "medium" | "high") => ({
  id,
  displayName: id,
  providerId,
  model: id,
  costTier,
  roles: [...roles],
  strengths: id,
});

function config(over: Partial<Config["policy"]> = {}): Config {
  return {
    version: 1,
    providers: [
      { id: "anthropic", kind: "anthropic", apiKeyEnv: "A" },
      { id: "google", kind: "gemini", apiKeyEnv: "G" },
      { id: "cli", kind: "claude-code" },
    ],
    agents: [
      agent("a", "anthropic", "high"),
      agent("b", "anthropic", "medium"),
      agent("g", "google", "low"),
      agent("c", "cli", "medium"),
    ],
    policy: {
      pins: [],
      fallbackChains: [],
      rules: [],
      preferences: "",
      distinctCritic: true,
      autoConfirmBelowConfidence: 0.6,
      maxReplacementsPerSlot: 2,
      stallAfterMs: { api: 1000, cli: 3000 },
      ...over,
    },
    budgets: { maxSteps: 10, maxUsd: 1, maxWallClockMs: 60_000 },
    defaults: { mode: "auto" },
  } as Config;
}

const subtask = {
  id: "s1",
  title: "t",
  description: "d",
  dependsOn: [],
  roleHint: "researcher" as const,
  output: { key: "k" },
  inputKeys: [],
  status: "running" as const,
};

function setup(cfg = config(), agentId = "a") {
  const events: EventBody[] = [];
  const emit = (e: EventBody) => void events.push(e);
  const slot = new Slot({
    role: "researcher",
    agentId,
    provenance: "jev",
    standby: [
      { agentId: "b", probability: 0.3 },
      { agentId: "g", probability: 0.2 },
    ],
    emit,
    now: () => Date.now(),
  });
  const supervisor = new SlotSupervisor({
    config: cfg,
    emit,
    now: () => Date.now(),
    budget: () => ({ stepsRemaining: 5, usdRemaining: 1, msRemaining: 1000 }),
    checkIntervalMs: 100,
  });
  const of = <K extends TraceEvent["kind"]>(kind: K) =>
    events.filter((e) => e.kind === kind) as Extract<EventBody, { kind: K }>[];
  return { events, slot, supervisor, of };
}

const takeoverRequest = (
  s: ReturnType<typeof setup>,
  over: Partial<Parameters<SlotSupervisor["takeover"]>[0]> = {},
) => ({
  slot: s.slot,
  attemptAgentId: s.slot.agentId,
  subtask,
  reason: { kind: "failed" as const, detail: "boom" },
  lastBeatAt: 0,
  detectedAt: 0,
  log: new AttemptLog(),
  inputs: {},
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("stall detection under a fake clock", () => {
  it("nudges an API agent at the threshold, then declares it stalled after the grace", async () => {
    const { slot, supervisor, of } = setup();
    slot.start("s1");
    const nudge = vi.fn();
    const watch = supervisor.watch(slot, { subtaskId: "s1", nudge });
    await vi.advanceTimersByTimeAsync(900);
    expect(of("slot.stalled")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(of("slot.stalled")).toMatchObject([{ role: "researcher", nudged: true }]);
    expect(of("slot.stalled")[0]!.silentMs).toBeGreaterThanOrEqual(1000);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(slot.state).toBe("stalled");
    expect(watch.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(watch.signal.aborted).toBe(true);
    expect(watch.cause()).toMatchObject({ kind: "stalled" });
    expect(watch.signal.reason).toBeInstanceOf(AttemptAborted);
    watch.stop();
  });

  it("an event after the nudge returns the slot to running", async () => {
    const { slot, supervisor, of } = setup();
    slot.start("s1");
    const watch = supervisor.watch(slot, { subtaskId: "s1" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(slot.state).toBe("stalled");
    watch.beat();
    await vi.advanceTimersByTimeAsync(300);
    expect(slot.state).toBe("running");
    expect(watch.signal.aborted).toBe(false);
    expect(of("slot.stalled")).toHaveLength(1);
    watch.stop();
  });

  it("heartbeats keep an agent alive indefinitely", async () => {
    const { slot, supervisor } = setup();
    slot.start("s1");
    const watch = supervisor.watch(slot, { subtaskId: "s1" });
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(500);
      watch.beat();
    }
    expect(watch.signal.aborted).toBe(false);
    watch.stop();
  });

  it("CLI agents use the longer threshold and are not nudged", async () => {
    const { slot, supervisor, of } = setup(config(), "c");
    slot.start("s1");
    const nudge = vi.fn();
    const watch = supervisor.watch(slot, { subtaskId: "s1", nudge });
    await vi.advanceTimersByTimeAsync(2900);
    expect(watch.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(of("slot.stalled")).toMatchObject([{ nudged: false }]);
    expect(nudge).not.toHaveBeenCalled();
    expect(watch.signal.aborted).toBe(true);
    watch.stop();
  });

  it("the per-attempt cap fails an agent that keeps emitting but never finishes", async () => {
    const s = setup();
    const supervisor = new SlotSupervisor({
      config: config(),
      emit: () => {},
      budget: () => ({ stepsRemaining: 1, usdRemaining: 1, msRemaining: 1 }),
      attemptTimeoutMs: 5000,
      nudgeGraceMs: 500,
      checkIntervalMs: 100,
    });
    s.slot.start("s1");
    const nudge = vi.fn();
    const watch = supervisor.watch(s.slot, { subtaskId: "s1", nudge });
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(100);
      watch.beat();
    }
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(watch.cause()).toMatchObject({ kind: "timeout" });
    watch.stop();
  });

  it("kill ends every running attempt of the slot and reports whether anything ran", () => {
    const { slot, supervisor } = setup();
    slot.start("s1");
    expect(supervisor.kill("researcher")).toBe(false);
    const w1 = supervisor.watch(slot, { subtaskId: "s1" });
    const w2 = supervisor.watch(slot, { subtaskId: "s2" });
    expect(supervisor.kill("researcher", "stage lever")).toBe(true);
    expect(w1.cause()).toMatchObject({ kind: "operator_kill", detail: "stage lever" });
    expect(w2.signal.aborted).toBe(true);
    expect(supervisor.kill("planner")).toBe(false);
    w1.stop();
    w2.stop();
  });
});

describe("takeover", () => {
  it("emits failed, replacing, replaced in order and installs the standby", async () => {
    const s = setup();
    s.slot.start("s1");
    const log = new AttemptLog();
    log.observe({
      type: "tool_call",
      callId: "c1",
      tool: "github_get_contents",
      input: { path: "a.json" },
    });
    log.observe({
      type: "tool_result",
      callId: "c1",
      tool: "github_get_contents",
      ok: true,
      output: { x: 1 },
    });
    log.observe({ type: "text", text: "halfway" });
    const t = await s.supervisor.takeover(
      takeoverRequest(s, {
        log,
        reason: { kind: "operator_kill", detail: "kill" },
        effort: "medium",
      }),
    );
    expect(t).toMatchObject({ agentId: "b", effort: "high", adopted: false });
    expect(t!.handoff).toMatchObject({
      partialNotes: "halfway",
      filesInspected: ["a.json"],
      predecessor: { agentId: "a" },
    });
    expect(t!.handoff.cachedToolResults).toHaveLength(1);
    expect(t!.handoff.evidenceRecords).toHaveLength(1);
    expect(s.events.map((e) => e.kind).slice(-4)).toEqual([
      "agent.started",
      "slot.failed",
      "slot.replacing",
      "slot.replaced",
    ]);
    expect(s.slot.state).toBe("replacing");
    expect(s.slot.agentId).toBe("b");
    expect(s.of("slot.replacing")[0]!.selection).toMatchObject({ provenance: "standby", rank: 1 });
  });

  it("a provider-level failure skips same-provider standbys", async () => {
    const s = setup();
    s.slot.start("s1");
    const t = await s.supervisor.takeover(
      takeoverRequest(s, { errorText: "503 service unavailable" }),
    );
    expect(t!.agentId).toBe("g");
    expect(s.of("slot.replacing")[0]!.selection.skipped).toContainEqual({
      agentId: "b",
      reason: "provider anthropic is down",
    });
    expect(s.supervisor.providerDown("a")).toBe(true);
    expect(s.supervisor.providerDown("g")).toBe(false);
    // the mark expires after five minutes
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(s.supervisor.providerDown("a")).toBe(false);
  });

  it("an agent-level failure keeps same-provider standbys", async () => {
    const s = setup();
    s.slot.start("s1");
    const t = await s.supervisor.takeover(
      takeoverRequest(s, { errorText: "agent process crashed" }),
    );
    expect(t!.agentId).toBe("b");
  });

  it("rejected picks an equal or higher tier and records the critic's findings", async () => {
    const s = setup(config(), "b");
    s.slot.start("s1");
    s.slot.reject("s1", 2, [{ claim: "c", problem: "p", severity: "blocker" }]);
    const findings = [{ claim: "c", problem: "p", severity: "blocker" as const }];
    const t = await s.supervisor.takeover(
      takeoverRequest(s, {
        alreadySignalled: true,
        reason: { kind: "rejected", detail: "rejected twice" },
        criticFindings: findings,
      }),
    );
    // standby order is b(excluded), g(low), then a is not in the standby list; g is the only one
    expect(t!.agentId).toBe("g");
    expect(t!.handoff.criticFindings).toEqual(findings);
    expect(s.of("slot.failed")).toHaveLength(0);
  });

  it("stops at maxReplacementsPerSlot with slot.exhausted and a degraded slot", async () => {
    const s = setup(config({ maxReplacementsPerSlot: 1 }));
    s.slot.start("s1");
    const first = await s.supervisor.takeover(takeoverRequest(s));
    expect(first!.agentId).toBe("b");
    s.slot.start("s1");
    const second = await s.supervisor.takeover(takeoverRequest(s));
    expect(second).toBeNull();
    expect(s.of("slot.exhausted")).toMatchObject([
      { role: "researcher", subtaskId: "s1", degradedKey: "k" },
    ]);
    expect(s.of("slot.exhausted")[0]!.reason).toMatch(/1 replacements used/);
    expect(s.slot.state).toBe("degraded");
  });

  it("no eligible replacement is exhaustion", async () => {
    const s = setup(config(), "a");
    s.slot.start("s1");
    const solo = new Slot({
      role: "researcher",
      agentId: "a",
      provenance: "jev",
      standby: [],
      emit: () => {},
    });
    solo.start("s1");
    const t = await new SlotSupervisor({
      config: config(),
      emit: (e) => void s.events.push(e),
      budget: () => ({ stepsRemaining: 0, usdRemaining: 0, msRemaining: 0 }),
    }).takeover({ ...takeoverRequest(s), slot: solo });
    expect(t).toBeNull();
    expect(s.of("slot.exhausted")[0]!.reason).toMatch(/no eligible replacement/);
  });

  it("uses fresh routing only when the standby list is empty", async () => {
    const s = setup();
    const solo = new Slot({
      role: "researcher",
      agentId: "a",
      provenance: "jev",
      standby: [],
      emit: () => {},
    });
    solo.start("s1");
    const fresh = vi.fn().mockResolvedValue({ agentId: "g", probability: 0.6 });
    const sup = new SlotSupervisor({
      config: config(),
      emit: (e) => void s.events.push(e),
      budget: () => ({ stepsRemaining: 0, usdRemaining: 0, msRemaining: 0 }),
      freshRouting: fresh,
    });
    const t = await sup.takeover({ ...takeoverRequest(s), slot: solo });
    expect(fresh).toHaveBeenCalledWith("researcher", ["a"]);
    expect(t!.agentId).toBe("g");
    expect(s.of("slot.replacing")[0]!.selection.provenance).toBe("fresh");
  });

  it("pins are skipped when the pinned agent is the one that failed, then the chain applies", async () => {
    const cfg = config({
      pins: [{ role: "researcher", agentId: "a" }],
      fallbackChains: [{ role: "researcher", agentIds: ["g", "b"] }],
    });
    const s = setup(cfg);
    s.slot.start("s1");
    const t = await s.supervisor.takeover(takeoverRequest(s));
    expect(t!.agentId).toBe("g");
    expect(s.of("slot.replacing")[0]!.selection).toMatchObject({ provenance: "chain" });
    expect(s.of("slot.replacing")[0]!.selection.skipped).toContainEqual({
      agentId: "a",
      reason: "pinned agent is the one that failed",
    });
  });

  it("a second attempt failing behind the first adopts the replacement", async () => {
    const s = setup();
    s.slot.start("s1");
    s.slot.start("s2");
    const [x, y] = await Promise.all([
      s.supervisor.takeover(takeoverRequest(s)),
      s.supervisor.takeover(takeoverRequest(s, { subtask: { ...subtask, id: "s2" } })),
    ]);
    expect(x!.adopted).toBe(false);
    expect(y!.adopted).toBe(true);
    expect(y!.agentId).toBe(x!.agentId);
    expect(s.of("slot.replaced")).toHaveLength(1);
    expect(s.slot.replaced).toHaveLength(1);
  });

  it("the planner's handoff carries no subtask id in the trace", async () => {
    const s = setup();
    s.slot.start(undefined);
    await s.supervisor.takeover(takeoverRequest(s, { subtask: { ...subtask, id: "plan" } }));
    expect(s.of("slot.replacing")[0]!.subtaskId).toBeUndefined();
  });
});

describe("slot chaos", () => {
  it("parses every profile in plan.md 2.6", () => {
    expect(
      parseSlotChaos([
        "provider-down:anthropic",
        "rate-limit:google",
        "stall:researcher",
        "timeout:critic",
        "garbage:executor",
        "hallucinate:researcher",
        "kill-after:researcher:2",
        "kill-after:bad:x",
        "tool:osv_query:500",
      ]),
    ).toEqual({
      providerDown: ["anthropic"],
      rateLimit: ["google"],
      stall: ["researcher"],
      timeout: ["critic"],
      garbage: ["executor"],
      hallucinate: ["researcher"],
      killAfter: [{ role: "researcher", turns: 2 }],
    });
  });

  it("role chaos spares a replacement", async () => {
    let first = true;
    const inner = {
      capabilities: { toolCalling: true, structuredOutput: true, streaming: true, effort: true },
      test: async () => ({ ok: true, detail: "" }),
      async *run() {
        yield { type: "result" as const, output: { value: 1, evidence: [] } };
        yield { type: "done" as const, status: "ok" as const };
      },
    };
    const wrapped = chaosAdapter(inner, {
      chaos: parseSlotChaos(["garbage:researcher"]),
      providerId: "p",
      isFirstAgent: () => first,
    });
    const collect = async () => {
      const out = [];
      for await (const e of wrapped.run({
        role: "researcher",
        signal: new AbortController().signal,
      } as never))
        out.push(e);
      return out;
    };
    expect((await collect())[0]).toMatchObject({
      type: "result",
      output: expect.stringContaining("chaos"),
    });
    first = false;
    expect((await collect())[0]).toMatchObject({ output: { value: 1 } });
  });
});
