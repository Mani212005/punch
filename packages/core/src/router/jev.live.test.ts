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
    expect(routing.difficulty.score).toBeGreaterThanOrEqual(0);
    expect(routing.difficulty.score).toBeLessThanOrEqual(2);
    expect(["cheap", "deep"]).toContain(routing.roles.researcher?.choice);
    expect(routing.isSensitive).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("classifies an error and prechecks a claim", async () => {
    expect((await jev.classifyError({ text: "GET /x returned 404", status: 404 })).errorClass).toBe(
      "not_found",
    );
    const checked = await jev.precheckClaims([
      { id: "c", claim: "lodash 4.17.21 exists", evidence: "npm registry lists lodash 4.17.21" },
    ]);
    expect(checked.c).toBeGreaterThan(0.5);
  }, 30_000);
});
