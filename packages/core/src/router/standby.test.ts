import { describe, expect, it } from "vitest";
import { Config } from "@punch/shared";
import {
  buildStandby,
  bumpEffort,
  PROVIDER_HEALTH_TTL_MS,
  ProviderHealth,
  selectReplacement,
} from "./standby.js";

const agent = (
  id: string,
  providerId: string,
  costTier: "low" | "medium" | "high",
  roles: string[] = ["researcher", "critic", "executor"],
) => ({
  id,
  displayName: id,
  providerId,
  model: id,
  costTier,
  roles,
  strengths: "",
});

const config = (policy: Record<string, unknown> = {}) =>
  Config.parse({
    version: 1,
    providers: [],
    agents: [
      agent("a", "p1", "high"),
      agent("b", "p1", "medium"),
      agent("c", "p2", "low"),
      agent("d", "p3", "high"),
    ],
    policy: {
      pins: [],
      fallbackChains: [],
      rules: [],
      preferences: "",
      distinctCritic: true,
      ...policy,
    },
    budgets: { maxSteps: 1, maxUsd: 1, maxWallClockMs: 1 },
    defaults: { mode: "auto" },
  });

const base = {
  role: "researcher" as const,
  failedAgentId: "a",
  reason: { kind: "failed" as const, detail: "x" },
  triedAgentIds: [] as string[],
  now: 0,
};

describe("buildStandby", () => {
  it("lists every other eligible agent by descending probability, zero-probability last in config order", () => {
    const eligible = config().agents;
    const standby = buildStandby(
      [
        { id: "c", probability: 0.6 },
        { id: "a", probability: 0.4 },
      ],
      eligible,
      "a",
    );
    expect(standby.map((s) => s.agentId)).toEqual(["c", "b", "d"]);
    expect(standby[0]?.probability).toBe(0.6);
  });
});

describe("ProviderHealth", () => {
  it("expires a provider failure after 5 minutes", () => {
    const health = new ProviderHealth();
    health.markDown("p1", 1000);
    expect(health.isDown("p1", 1000 + PROVIDER_HEALTH_TTL_MS - 1)).toBe(true);
    expect(health.isDown("p1", 1000 + PROVIDER_HEALTH_TTL_MS)).toBe(false);
    expect(health.isDown("p2", 1000)).toBe(false);
  });
});

describe("selectReplacement", () => {
  it("skips a pin that is the failed agent, then uses the standby list", async () => {
    const got = await selectReplacement({
      ...base,
      config: config({ pins: [{ role: "researcher", agentId: "a" }] }),
      standby: [{ agentId: "b", probability: 0.5 }],
      providerHealth: new ProviderHealth(),
    });
    expect(got?.agentId).toBe("b");
    expect(got?.selection.skipped[0]?.reason).toMatch(/pinned agent is the one that failed/);
  });

  it("prefers a different pinned agent over chain and standby", async () => {
    const got = await selectReplacement({
      ...base,
      config: config({
        pins: [{ role: "researcher", agentId: "d" }],
        fallbackChains: [{ role: "researcher", agentIds: ["c"] }],
      }),
      standby: [{ agentId: "b", probability: 0.5 }],
      providerHealth: new ProviderHealth(),
    });
    expect(got).toMatchObject({ agentId: "d", selection: { provenance: "pin" } });
  });

  it("skips agents whose provider is marked down in providerHealth", async () => {
    const health = new ProviderHealth();
    health.markDown("p2", 0);
    const got = await selectReplacement({
      ...base,
      config: config(),
      standby: [
        { agentId: "c", probability: 0.5 },
        { agentId: "d", probability: 0.2 },
      ],
      providerHealth: health,
    });
    expect(got?.agentId).toBe("d");
    expect(got?.selection.skipped).toEqual([{ agentId: "c", reason: "provider p2 is down" }]);
  });

  it("allows the provider again after the 5-minute expiry", async () => {
    const health = new ProviderHealth();
    health.markDown("p2", 0);
    const got = await selectReplacement({
      ...base,
      now: PROVIDER_HEALTH_TTL_MS,
      config: config(),
      standby: [{ agentId: "c", probability: 0.5 }],
      providerHealth: health,
    });
    expect(got?.agentId).toBe("c");
  });

  it("keeps the critic distinct from the executor", async () => {
    const got = await selectReplacement({
      ...base,
      role: "critic",
      config: config(),
      executorAgentId: "b",
      standby: [
        { agentId: "b", probability: 0.5 },
        { agentId: "c", probability: 0.2 },
      ],
      providerHealth: new ProviderHealth(),
    });
    expect(got?.agentId).toBe("c");
  });

  it("falls back to lower tiers on rejection only when no equal or higher tier exists", async () => {
    const got = await selectReplacement({
      ...base,
      reason: { kind: "rejected", detail: "x" },
      config: config(),
      standby: [{ agentId: "c", probability: 0.5 }],
      providerHealth: new ProviderHealth(),
    });
    expect(got?.agentId).toBe("c");
  });

  it("uses fresh routing only when the standby list is empty, with the tried agents excluded", async () => {
    let excluded: string[] = [];
    const got = await selectReplacement({
      ...base,
      triedAgentIds: ["b"],
      config: config(),
      standby: [],
      providerHealth: new ProviderHealth(),
      freshRouting: async (ex) => {
        excluded = ex;
        return { agentId: "c", probability: 0.7 };
      },
    });
    expect(excluded.sort()).toEqual(["a", "b"]);
    expect(got).toMatchObject({
      agentId: "c",
      selection: { provenance: "fresh", probability: 0.7 },
    });
  });

  it("does not call fresh routing when a non-empty standby list is exhausted", async () => {
    const got = await selectReplacement({
      ...base,
      triedAgentIds: ["b"],
      config: config(),
      standby: [{ agentId: "b", probability: 0.5 }],
      providerHealth: new ProviderHealth(),
      freshRouting: async () => {
        throw new Error("must not be called");
      },
    });
    expect(got).toBeNull();
  });

  it("bumps effort one level unless the adapter has no effort", async () => {
    const common = {
      ...base,
      config: config(),
      standby: [{ agentId: "b", probability: 0.5 }],
      providerHealth: new ProviderHealth(),
      failedEffort: "low" as const,
    };
    expect((await selectReplacement(common))?.effort).toBe("medium");
    expect(
      (await selectReplacement({ ...common, supportsEffort: () => false }))?.effort,
    ).toBeUndefined();
    expect(bumpEffort("high")).toBe("high");
    expect(bumpEffort(undefined)).toBeUndefined();
  });
});
