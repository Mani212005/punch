import { describe, expect, it } from "vitest";
import { createJev, createTypeSafeTransport } from "./jev.js";

// Opt-in: spends a few Jev calls. Run with TYPESAFE_API_KEY set. Confirms the real
// /v1/systemone response matches the shapes jev.ts parses (choice, score, noul).
describe.skipIf(!process.env.TYPESAFE_API_KEY)("Jev live shape", () => {
  const jev = createJev({
    evaluate: (request, options) => createTypeSafeTransport().evaluate(request, options),
  });
  const agent = (id: string, costTier: "low" | "high", strengths: string) => ({
    id,
    displayName: id,
    providerId: "p",
    model: id,
    costTier,
    roles: ["researcher" as const],
    strengths,
  });

  it("routes a task", async () => {
    const routing = await jev.routeTask({
      task: {
        brief: "Triage vulnerable dependencies of a small repo",
        expectedOutputs: ["report"],
        irreversibleActionsPossible: true,
      },
      agents: [
        agent("cheap", "low", "fast bulk lookups"),
        agent("deep", "high", "careful reasoning"),
      ],
      preferences: "cheap for research",
      budget: { maxSteps: 50, maxUsd: 2, maxWallClockMs: 600_000 },
      roles: ["researcher"],
    });

    // Model is returned as concrete version (e.g. "jev-1.13.0")
    expect(routing.model).toMatch(/^jev-\d+\.\d+\.\d+/);

    // Score question shape: score, levels, normalized, probabilities, confidence
    expect(routing.difficulty.score).toBeGreaterThanOrEqual(0);
    expect(routing.difficulty.score).toBeLessThanOrEqual(2);
    expect(routing.difficulty.levels).toBe(3);
    expect(routing.difficulty.normalized).toBeGreaterThanOrEqual(0);
    expect(routing.difficulty.normalized).toBeLessThanOrEqual(1);
    expect(routing.difficulty.confidence).toBeGreaterThanOrEqual(0);
    expect(routing.difficulty.confidence).toBeLessThanOrEqual(1);
    expect(routing.difficulty.probabilities).toHaveLength(3);
    const probSum = routing.difficulty.probabilities.reduce((sum, p) => sum + p, 0);
    expect(probSum).toBeCloseTo(1, 1);

    // Choice question shape: choice, confidence, probabilities sorted descending
    const researcher = routing.roles.researcher;
    expect(researcher).toBeDefined();
    expect(["cheap", "deep"]).toContain(researcher?.choice);
    expect(researcher!.confidence).toBeGreaterThanOrEqual(0);
    expect(researcher!.confidence).toBeLessThanOrEqual(1);
    expect(researcher!.probabilities.length).toBe(2);
    expect(researcher!.probabilities[0]!.probability).toBeGreaterThanOrEqual(
      researcher!.probabilities[1]!.probability,
    );

    // Noul question shape: bare probability in 0..1
    expect(routing.needsExternalData).toBeGreaterThanOrEqual(0);
    expect(routing.needsExternalData).toBeLessThanOrEqual(1);
    expect(routing.isSensitive).toBeGreaterThanOrEqual(0);
    expect(routing.isSensitive).toBeLessThanOrEqual(1);
  }, 30_000);

  it("routes a subtask", async () => {
    const subtask = await jev.routeSubtask({
      subtask: {
        title: "Check lodash CVEs",
        description: "Query OSV for vulnerabilities in lodash",
        roleHint: "researcher",
      },
      brief: "Triage dependencies",
    });
    expect(subtask.assignee.choice).toBe("researcher");
    expect(subtask.assignee.confidence).toBeGreaterThanOrEqual(0);
    expect(subtask.complexity.score).toBeGreaterThanOrEqual(0);
    expect(subtask.complexity.score).toBeLessThanOrEqual(2);
  }, 30_000);

  it("classifies an error and prechecks a claim", async () => {
    const errorResult = await jev.classifyError({ text: "GET /x returned 404", status: 404 });
    expect(errorResult.errorClass).toBe("not_found");
    expect(errorResult.confidence).toBeGreaterThanOrEqual(0);
    expect(errorResult.probabilities.length).toBeGreaterThan(0);

    const checked = await jev.precheckClaims([
      { id: "c", claim: "lodash 4.17.21 exists", evidence: "npm registry lists lodash 4.17.21" },
    ]);
    expect(checked.c).toBeGreaterThan(0.5);
    expect(checked.c).toBeLessThanOrEqual(1);
  }, 30_000);
});
