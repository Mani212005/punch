import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Config } from "@punch/shared";
import type { Effort, SlotRole } from "@punch/shared";
import { createJev, createRecordedTransport } from "./jev.js";
import type { JevAnswer, RecordedExchange } from "./jev.js";
import { classifyError } from "./classify-error.js";
import { JevUnavailableError, routeSubtask, routeTask } from "./policy.js";
import type { RouteEvent } from "./policy.js";
import { ProviderHealth, selectReplacement } from "./standby.js";

const fixtureDir = new URL("../../../../fixtures/router/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
const { agents } = read("agents.json");
const { cases } = read("cases.json") as { cases: Case[] };

interface Case {
  name: string;
  kind: "route" | "subtask" | "classify" | "replace";
  mode?: "auto" | "manual";
  policy?: Record<string, unknown>;
  roles?: SlotRole[];
  jev?: Record<string, unknown>;
  jevError?: { message: string; status?: number };
  input?: Record<string, unknown>;
  expect: Record<string, unknown>;
}

function makeConfig(policy: Record<string, unknown> = {}): Config {
  return Config.parse({
    version: 1,
    providers: [
      { id: "anthropic", kind: "anthropic", apiKeyEnv: "A" },
      { id: "gemini", kind: "gemini", apiKeyEnv: "G" },
      { id: "claude-code", kind: "claude-code" },
    ],
    agents,
    policy: {
      pins: [],
      fallbackChains: [],
      rules: [],
      preferences: "prefer cheap research",
      distinctCritic: true,
      ...policy,
    },
    budgets: { maxSteps: 100, maxUsd: 5, maxWallClockMs: 600_000 },
    defaults: { mode: "auto" },
  });
}

const DIFFICULTY_LEGEND: Record<string, string> = {
  "0": "simple: a small, well-specified task; one clear source of data, few dependencies, little judgment.",
  "1": "moderate: several sources or steps, some judgment about trade-offs, a typical repository.",
  "2": "hard: many interdependent steps, ambiguous or conflicting evidence, high stakes for errors.",
};
const COMPLEXITY_LEGEND: Record<string, string> = {
  "0": "low: a mechanical lookup or transformation with an obvious answer.",
  "1": "medium: needs some reasoning over several inputs.",
  "2": "high: needs deep multi-step reasoning, weighing conflicting evidence, or careful synthesis.",
};

const levelAnswer = (
  probs: number[],
  conf: number,
  legend?: Record<string, string>,
): JevAnswer => ({
  type: "score",
  score: probs.reduce((sum, p, i) => sum + p * i, 0),
  legend: legend ?? Object.fromEntries(probs.map((_, i) => [String(i), `level ${i}`])),
  probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
  confidence: conf,
});
const choiceAnswer = (probs: Record<string, number>, conf: number): JevAnswer => ({
  type: "choice",
  choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0]![0],
  probabilities: probs,
  confidence: conf,
});
const response = (answers: Record<string, JevAnswer>) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 300, output_tokens: 30 },
});

function exchangeFor(c: Case): RecordedExchange {
  if (c.jevError) return { questionIds: [], error: c.jevError };
  const jev = c.jev as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (c.kind === "route") {
    const conf = jev.conf as number;
    const answers: Record<string, JevAnswer> = {
      difficulty: levelAnswer(jev.difficulty, conf, DIFFICULTY_LEGEND),
      needs_external_data: { type: "noul", noul: 0.9 },
      is_sensitive: { type: "noul", noul: 0.95 },
    };
    for (const [role, probs] of Object.entries(jev.roles))
      answers[`role_${role}`] = choiceAnswer(probs as Record<string, number>, conf);
    return { questionIds: Object.keys(answers), response: response(answers) };
  }
  if (c.kind === "subtask") {
    return {
      questionIds: ["assignee", "complexity"],
      response: response({
        assignee: choiceAnswer(jev.assignee, 0.9),
        complexity: levelAnswer(jev.complexity, 0.8, COMPLEXITY_LEGEND),
      }),
    };
  }
  return {
    questionIds: ["error_class"],
    response: response({ error_class: choiceAnswer(jev as Record<string, number>, 0.9) }),
  };
}

/** A route case's recorded exchange must match the question ids the router really asks. */
function routeTransport(c: Case) {
  if (!c.jev && !c.jevError) return createRecordedTransport([]);
  if (c.jevError) {
    const err = c.jevError;
    return {
      requests: [],
      evaluate: () => Promise.reject(Object.assign(new Error(err.message), { status: err.status })),
    };
  }
  return createRecordedTransport([exchangeFor(c)]);
}

describe("router: 20 labeled cases", () => {
  it("has exactly 20 cases", () => expect(cases).toHaveLength(20));

  for (const c of cases) {
    it(c.name, async () => {
      const transport = routeTransport(c);
      const jev = createJev(transport);

      if (c.kind === "route") {
        const events: RouteEvent[] = [];
        const run = () =>
          routeTask(jev, {
            config: makeConfig(c.policy),
            mode: c.mode ?? "auto",
            task: {
              brief: "triage deps",
              expectedOutputs: ["report"],
              irreversibleActionsPossible: true,
            },
            ...(c.roles ? { roles: c.roles } : {}),
            emit: (e) => events.push(e),
          });
        const expected = c.expect as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (expected.throws) {
          await expect(run()).rejects.toBeInstanceOf(JevUnavailableError);
          return;
        }
        const plan = await run();
        if (expected.difficulty) expect(plan.difficulty).toBe(expected.difficulty);
        for (const [role, [agentId, provenance]] of Object.entries(
          expected.assign as Record<string, [string, string]>,
        )) {
          const a = plan.assignments.find((x) => x.role === role);
          expect([a?.agentId, a?.provenance]).toEqual([agentId, provenance]);
          const decided = events.find((e) => e.kind === "route.decided" && e.role === role);
          expect(decided).toMatchObject({ agentId, provenance });
        }
        for (const [role, ids] of Object.entries(
          (expected.standby ?? {}) as Record<string, string[]>,
        )) {
          expect(
            plan.assignments.find((x) => x.role === role)?.standby.map((s) => s.agentId),
          ).toEqual(ids);
        }
        if ("needsConfirmation" in expected)
          expect(plan.needsConfirmation).toBe(expected.needsConfirmation);
        if (expected.lowConfidence) expect(plan.lowConfidenceRoles).toEqual(expected.lowConfidence);
        if ("warnings" in expected) expect(plan.warnings).toHaveLength(expected.warnings);
        if ("skipped" in expected)
          expect(events.filter((e) => e.kind === "route.skipped")).toHaveLength(expected.skipped);
        for (const [role, conf] of Object.entries(
          (expected.confidence ?? {}) as Record<string, number>,
        )) {
          expect(plan.assignments.find((x) => x.role === role)?.confidence).toBeCloseTo(conf);
        }
      } else if (c.kind === "subtask") {
        const routed = await routeSubtask(jev, {
          subtask: { title: "t", description: "d", roleHint: "researcher" },
          brief: "b",
        });
        expect(routed.assignee).toBe(c.expect.assignee);
        expect(routed.effort).toBe(c.expect.effort);
      } else if (c.kind === "classify") {
        const got = await classifyError(c.input as { text: string; status?: number }, { jev });
        expect(got).toMatchObject(c.expect);
      } else {
        const i = c.input as {
          role: SlotRole;
          failedAgentId: string;
          reason: "failed" | "rejected";
          standby: string[];
          tried?: string[];
          chain?: string[];
          failedEffort?: Effort;
          providerLevelFailure?: boolean;
        };
        const config = makeConfig(
          i.chain ? { fallbackChains: [{ role: i.role, agentIds: i.chain }] } : {},
        );
        const got = await selectReplacement({
          role: i.role,
          failedAgentId: i.failedAgentId,
          reason: { kind: i.reason, detail: "test" },
          config,
          standby: i.standby.map((agentId) => ({ agentId, probability: 0.1 })),
          triedAgentIds: i.tried ?? [],
          providerHealth: new ProviderHealth(),
          now: 0,
          ...(i.failedEffort ? { failedEffort: i.failedEffort } : {}),
          ...(i.providerLevelFailure ? { providerLevelFailure: true } : {}),
        });
        const expected = c.expect as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(got?.agentId ?? null).toBe(expected.agentId);
        if (got) {
          expect(got.selection.provenance).toBe(expected.provenance);
          if (expected.rank) expect(got.selection.rank).toBe(expected.rank);
          if (expected.effort) expect(got.effort).toBe(expected.effort);
          if (expected.skippedIds)
            expect(got.selection.skipped.map((s) => s.agentId)).toEqual(expected.skippedIds);
        }
      }
    });
  }
});

describe("fixtures/router real-shaped responses", () => {
  it("validates recorded fixtures for noul, score, and choice", () => {
    const noul = read("noul.json");
    const score = read("score.json");
    const choice = read("choice.json");

    expect(noul.model).toMatch(/^jev-/);
    expect(noul.answers.needs_external_data.type).toBe("noul");
    expect(typeof noul.answers.needs_external_data.noul).toBe("number");

    expect(score.model).toMatch(/^jev-/);
    expect(score.answers.difficulty.type).toBe("score");
    expect(score.answers.difficulty.legend["0"]).toContain("simple");

    expect(choice.model).toMatch(/^jev-/);
    expect(choice.answers.error_class.type).toBe("choice");
    expect(choice.answers.error_class.choice).toBe("not_found");
  });
});
