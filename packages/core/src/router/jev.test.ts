import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createJev, createRecordedTransport, JevResponse } from "./jev.js";
import { classifyErrorByCode } from "./classify-error.js";
import { difficultyFromScore, effortFromComplexity } from "./policy.js";

const fixtureDir = new URL("../../../../fixtures/router/", import.meta.url);
const readFixture = (name: string) => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));

const agent = (id: string, roles: string[]) => ({
  id,
  displayName: id,
  providerId: "p",
  model: id,
  costTier: "low" as const,
  roles: roles as never,
  strengths: `${id} strengths`,
});

describe("Jev request shape", () => {
  it("sends one request with the plan.md 3.5 questions and per-agent choice options", async () => {
    const transport = createRecordedTransport([
      {
        questionIds: ["difficulty", "needs_external_data", "is_sensitive", "role_researcher"],
        response: {
          model: "jev-1.13.0",
          answers: {
            difficulty: {
              type: "score",
              score: 1,
              legend: { "0": "a", "1": "b", "2": "c" },
              probabilities: { "0": 0, "1": 1, "2": 0 },
              confidence: 0.9,
            },
            needs_external_data: { type: "noul", noul: 0.9 },
            is_sensitive: { type: "noul", noul: 0.1 },
            role_researcher: {
              type: "choice",
              choice: "x",
              probabilities: { x: 0.7, y: 0.3 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const routing = await createJev(transport).routeTask({
      task: { brief: "b", expectedOutputs: [], irreversibleActionsPossible: false },
      agents: [agent("x", ["researcher"]), agent("y", ["researcher"]), agent("solo", ["planner"])],
      preferences: "",
      budget: { maxSteps: 1, maxUsd: 1, maxWallClockMs: 1 },
      roles: ["researcher", "planner"],
    });
    expect(transport.requests).toHaveLength(1);
    const q = transport.requests[0]!.questions;
    expect(q.difficulty?.type).toBe("score");
    expect(q.needs_external_data?.type).toBe("noul");
    expect(q.is_sensitive?.type).toBe("noul");
    expect(
      Object.keys(
        q.role_researcher && "criteria" in q.role_researcher
          ? (q.role_researcher.criteria as object)
          : {},
      ),
    ).toEqual(["x", "y"]);
    expect(q.role_planner).toBeUndefined(); // single eligible agent: nothing to ask
    expect(routing.roles.researcher?.probabilities.map((p) => p.id)).toEqual(["x", "y"]);
    expect(routing.eligible.planner).toEqual(["solo"]);
  });

  it("asks one Noul per claim in the critic pre-check", async () => {
    const transport = createRecordedTransport([
      {
        questionIds: ["claim_0", "claim_1"],
        response: {
          model: "m",
          answers: { claim_0: { type: "noul", noul: 0.9 }, claim_1: { type: "noul", noul: 0.1 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const got = await createJev(transport).precheckClaims([
      { id: "c1", claim: "A", evidence: "e1" },
      { id: "c2", claim: "B", evidence: "e2" },
    ]);
    expect(got).toEqual({ c1: 0.9, c2: 0.1 });
  });

  it("rejects a response with the wrong shape", () => {
    expect(() =>
      JevResponse.parse({
        model: "m",
        answers: { a: { type: "noul", noul: 2 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow();
  });

  it("parses real responses for noul, score, choice from fixtures/router", () => {
    const noulFixture = readFixture("noul.json");
    const scoreFixture = readFixture("score.json");
    const choiceFixture = readFixture("choice.json");

    expect(JevResponse.parse(noulFixture)).toMatchObject({
      model: "jev-1.13.0",
      answers: { needs_external_data: { type: "noul", noul: 0.43 } },
      usage: { input_tokens: 296, output_tokens: 22 },
    });
    expect(JevResponse.parse(scoreFixture)).toMatchObject({
      model: "jev-1.13.0",
      answers: {
        difficulty: {
          type: "score",
          score: 0.69,
          confidence: 0.53,
          probabilities: { "0": 0.31, "1": 0.69, "2": 0 },
        },
      },
    });
    expect(JevResponse.parse(choiceFixture)).toMatchObject({
      model: "jev-1.13.0",
      answers: {
        error_class: {
          type: "choice",
          choice: "not_found",
          confidence: 1,
        },
      },
    });
  });

  it("evaluates real recorded fixtures directly in createRecordedTransport", async () => {
    const transport = createRecordedTransport([
      readFixture("choice.json"),
      readFixture("route-task.json"),
      readFixture("route-subtask.json"),
    ]);
    const jev = createJev(transport);

    const errorResult = await jev.classifyError({ text: "GET /x returned 404", status: 404 });
    expect(errorResult.errorClass).toBe("not_found");
    expect(errorResult.confidence).toBe(1);

    const subtaskResult = await jev.routeSubtask({
      subtask: { title: "Query OSV", description: "check osv", roleHint: "researcher" },
      brief: "Triage dependencies",
    });
    expect(subtaskResult.assignee.choice).toBe("researcher");
    expect(subtaskResult.complexity.score).toBeCloseTo(0.01);

    const taskResult = await jev.routeTask({
      task: { brief: "b", expectedOutputs: ["report"], irreversibleActionsPossible: true },
      agents: [agent("cheap", ["researcher"]), agent("deep", ["researcher"])],
      preferences: "cheap for research",
      budget: { maxSteps: 50, maxUsd: 2, maxWallClockMs: 600_000 },
      roles: ["researcher"],
    });
    expect(taskResult.difficulty.score).toBeCloseTo(0.84);
    expect(taskResult.roles.researcher?.choice).toBe("cheap");
    expect(taskResult.needsExternalData).toBeCloseTo(0.94);
    expect(taskResult.isSensitive).toBeCloseTo(0.25);
  });
});

describe("thresholds in code", () => {
  it("maps score to difficulty and complexity to effort", () => {
    expect(
      ["0", "0.66", "0.67", "1.32", "1.33", "2"].map((s) => difficultyFromScore(Number(s))),
    ).toEqual(["simple", "simple", "moderate", "moderate", "hard", "hard"]);
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map(effortFromComplexity)).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });
});

describe("classifyErrorByCode", () => {
  it.each([
    [{ text: "x", status: 429 }, "transient"],
    [{ text: "x", status: 401 }, "permanent"],
    [{ text: "ECONNRESET" }, "transient"],
    [{ text: "package does not exist" }, "not_found"],
    [{ text: "something weird" }, "permanent"],
  ])("%j -> %s", (input, expected) => {
    expect(classifyErrorByCode(input)).toBe(expected);
  });
});
