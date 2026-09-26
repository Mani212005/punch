import { describe, expect, it } from "vitest";
import { AgentEvent, ChaosProfile, Config, Handoff, Plan, SlotState } from "./index.js";

const config = {
  version: 1,
  providers: [
    { id: "anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { id: "cc", kind: "claude-code" },
  ],
  agents: [
    {
      id: "opus",
      displayName: "Opus",
      providerId: "anthropic",
      model: "claude-opus-5",
      costTier: "high",
      roles: ["orchestrator", "planner"],
      strengths: "planning",
    },
  ],
  policy: {
    pins: [],
    fallbackChains: [],
    rules: [],
    preferences: "",
    distinctCritic: true,
  },
  budgets: { maxSteps: 100, maxUsd: 5, maxWallClockMs: 600_000 },
  defaults: { mode: "auto" },
};

describe("shared schemas", () => {
  it("applies plan.md 3.2 policy defaults", () => {
    const parsed = Config.parse(config);
    expect(parsed.policy.autoConfirmBelowConfidence).toBe(0.6);
    expect(parsed.policy.maxReplacementsPerSlot).toBe(2);
    expect(parsed.policy.stallAfterMs).toEqual({ api: 45_000, cli: 120_000 });
  });

  it("rejects a provider with an unknown kind", () => {
    const bad = { ...config, providers: [{ id: "x", kind: "nope" }] };
    expect(Config.safeParse(bad).success).toBe(false);
  });

  it("knows every slot state from plan.md 2.1", () => {
    expect(SlotState.options).toEqual([
      "assigned",
      "running",
      "completed",
      "stalled",
      "failed",
      "rejected",
      "replacing",
      "exhausted",
      "degraded",
    ]);
  });

  it("validates a plan DAG and a handoff packet", () => {
    const subtask = {
      id: "s1",
      title: "t",
      description: "d",
      dependsOn: [],
      roleHint: "researcher",
      output: { key: "deps" },
    };
    expect(Plan.parse({ subtasks: [subtask] }).subtasks[0]?.status).toBe("pending");
    const handoff = Handoff.parse({
      subtask,
      reason: { kind: "failed", detail: "503" },
      predecessor: { agentId: "a", displayName: "A", turnsUsed: 2, usdUsed: 0.1 },
      inputs: {},
      cachedToolResults: [],
      partialNotes: null,
      criticFindings: null,
      budget: { stepsRemaining: 1, usdRemaining: 1, msRemaining: 1 },
    });
    expect(handoff.reason.kind).toBe("failed");
  });

  it("validates adapter events and chaos profiles", () => {
    expect(AgentEvent.parse({ type: "done", status: "refusal" }).type).toBe("done");
    for (const p of [
      "provider-down:anthropic",
      "stall:critic",
      "kill-after:researcher:3",
      "tool:osv:500",
    ]) {
      expect(ChaosProfile.safeParse(p).success).toBe(true);
    }
    expect(ChaosProfile.safeParse("stall:orchestrator").success).toBe(false);
  });
});
