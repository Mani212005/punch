import { describe, expect, it } from "vitest";
import {
  CRITIC_CHALLENGE_IDS,
  Claim,
  CriticVerdict,
  Handoff,
  InvestigationFinding,
  InvestigationReport,
  Role,
  SandboxValidation,
  SlotRole,
} from "./index.js";

const step = { status: "pass", exitCode: 0, durationMs: 10, logTail: "" };
const run = {
  install: step,
  build: step,
  test: step,
  counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
  failingTests: [],
};
const sandbox = {
  isolation: "docker",
  baseline: run,
  candidate: run,
  newFailures: [],
  changedFiles: [],
  fixedFailures: [],
  verdict: "PASS",
  evidenceIds: [],
};
const finding = {
  id: "f1",
  dependency: "foo",
  version: "2.1.4",
  advisoryIds: ["GHSA-xxxx-yyyy-zzzz"],
  severity: "HIGH",
  reachability: {
    verdict: "NOT_REACHABLE",
    exists: "yes",
    exposed: "unknown",
    exploitable: "no",
    affectedSymbols: ["parse"],
    claimIds: ["c1"],
    summary: "parse() never imported",
  },
  upgrade: { from: "2.1.4", to: "2.4.0" },
  upgradeImpact: { level: "LOW", detectedRisks: [], unknowns: ["no CI config"], claimIds: [] },
  sandbox,
  critic: "ACCEPTED",
  recommendedAction: "UPGRADE",
  claimIds: ["c1"],
};

const challenges = CRITIC_CHALLENGE_IDS.map((challenge) => ({
  challenge,
  outcome: "survived",
  reasoning: "ok",
  evidenceIds: [],
}));

describe("investigation schemas", () => {
  it("keeps existing roles and adds the investigation roles", () => {
    for (const r of ["orchestrator", "planner", "researcher", "executor", "critic"]) {
      expect(Role.safeParse(r).success).toBe(true);
    }
    for (const r of ["inventory", "reachability", "impact", "investigator"]) {
      expect(SlotRole.safeParse(r).success).toBe(true);
    }
    expect(Role.safeParse("validator").success).toBe(false);
    expect(SlotRole.safeParse("orchestrator").success).toBe(false);
  });

  it("round-trips a claim and rejects unknown statuses", () => {
    const claim = {
      id: "c1",
      text: "foo.parse() unused",
      kind: "reachability",
      findingId: "f1",
      author: { role: "reachability", agentId: "a1" },
      evidenceRefs: ["e1"],
      status: "verified",
      verifier: { role: "critic", agentId: "a4" },
    };
    expect(Claim.parse(JSON.parse(JSON.stringify(claim)))).toEqual(claim);
    expect(Claim.safeParse({ ...claim, status: "maybe" }).success).toBe(false);
  });

  it("accepts the validator as a claim author without an agent id", () => {
    const parsed = Claim.parse({
      id: "c2",
      text: "candidate tests pass",
      kind: "sandbox",
      findingId: "f1",
      author: { role: "validator" },
      evidenceRefs: [],
      status: "proposed",
      verifier: null,
    });
    expect(parsed.author.agentId).toBeUndefined();
  });

  it("round-trips a finding and a full report", () => {
    expect(InvestigationFinding.parse(finding)).toMatchObject({ id: "f1" });
    const report = {
      summary: {
        repository: "example/repo",
        dependenciesAnalyzed: 143,
        knownVulnerabilities: 12,
        investigated: 12,
        relevantReachable: 5,
        validatedActionable: 3,
        requiresHumanReview: 2,
      },
      findings: [finding],
      claims: [],
      evidence: [],
    };
    expect(InvestigationReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("rejects an upgrade impact that is not LOW, MEDIUM, or HIGH", () => {
    const bad = { ...finding, upgradeImpact: { level: 0.87, detectedRisks: [], unknowns: [] } };
    expect(InvestigationFinding.safeParse(bad).success).toBe(false);
  });

  it("represents a validation that was not run for lack of isolation", () => {
    const parsed = SandboxValidation.parse({
      isolation: "none",
      note: "not run (no isolation available)",
      baseline: null,
      candidate: null,
      verdict: "NOT_RUN",
    });
    expect(parsed.verdict).toBe("NOT_RUN");
    expect(parsed.newFailures).toEqual([]);
  });

  it("has ten critic challenges", () => {
    expect(new Set(CRITIC_CHALLENGE_IDS).size).toBe(10);
  });

  it("requires a rejection to carry a new task", () => {
    const rejected = {
      decision: "REJECTED",
      findingId: "f1",
      challenges,
      reason: "Reachability claim was unsupported",
      missingEvidence: ["call-site analysis"],
      newTask: { role: "reachability", title: "Call-site search", description: "search foo.parse" },
    };
    expect(CriticVerdict.parse(rejected)).toMatchObject({ decision: "REJECTED" });
    const noTask: Record<string, unknown> = { ...rejected };
    delete noTask.newTask;
    expect(CriticVerdict.safeParse(noTask).success).toBe(false);
    expect(
      CriticVerdict.safeParse({ decision: "ACCEPTED", findingId: "f1", challenges }).success,
    ).toBe(true);
  });

  it("defaults handoff filesInspected and evidenceRecords for older packets", () => {
    const parsed = Handoff.parse({
      subtask: {
        id: "s1",
        title: "t",
        description: "d",
        dependsOn: [],
        roleHint: "reachability",
        output: { key: "k" },
      },
      reason: { kind: "failed", detail: "timeout" },
      predecessor: { agentId: "a", displayName: "A", turnsUsed: 1, usdUsed: 0 },
      inputs: {},
      cachedToolResults: [],
      partialNotes: null,
      criticFindings: null,
      budget: { stepsRemaining: 1, usdRemaining: 1, msRemaining: 1 },
    });
    expect(parsed.filesInspected).toEqual([]);
    expect(parsed.evidenceRecords).toEqual([]);
  });
});
