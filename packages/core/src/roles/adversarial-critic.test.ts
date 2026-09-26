import { describe, expect, it } from "vitest";
import {
  CRITIC_CHALLENGE_IDS,
  type CriticChallengeId,
  CriticVerdict as SharedCriticVerdict,
} from "@punch/shared";
import { Blackboard } from "../blackboard.js";
import type { Jev } from "../router/jev.js";
import type { TraceEventInput } from "../trace/writer.js";
import { ToolLedger, type Draft } from "./common.js";
import { reviewDraft } from "./critic.js";
import { deps, result, scriptedAdapter, subtask } from "./test-helpers.js";

const fakeJevSupporting: Pick<Jev, "precheckClaims"> = {
  async precheckClaims(claims) {
    return Object.fromEntries(claims.map((c) => [c.id, 0.95]));
  },
};

const fakeJevRefuting: Pick<Jev, "precheckClaims"> = {
  async precheckClaims(claims) {
    return Object.fromEntries(claims.map((c) => [c.id, 0.05]));
  },
};

describe("Adversarial Critic — Ten Challenges (CRITIC_CHALLENGE_IDS)", () => {
  it("defines the ten challenges in the exact specified order", () => {
    expect(CRITIC_CHALLENGE_IDS).toEqual([
      "vulnerability_applies",
      "package_present",
      "functionality_used",
      "code_reachable",
      "patched_version_real",
      "upgrade_compatible",
      "sources_contradict",
      "evidence_current",
      "safer_mitigation",
      "unsupported_assumption",
    ]);
  });

  const runChallengeTest = async (
    failedChallenge: CriticChallengeId,
    reason: string,
    claimText: string,
  ) => {
    const ledger = new ToolLedger();
    const board = new Blackboard();
    const critic = scriptedAdapter([
      () =>
        result({
          decision: "REJECTED",
          challenges: [
            {
              challenge: failedChallenge,
              outcome: "failed",
              reasoning: reason,
              evidenceIds: ["ev_1"],
            },
          ],
          findings: [
            {
              claim: claimText,
              problem: reason,
              severity: "blocker",
              evidenceRef: "ev_1",
            },
          ],
          reason,
          missingEvidence: [reason],
        }),
    ]);

    const draft: Draft = {
      value: { finding: "CVE-2024-TEST" },
      evidence: [{ source: "ev_1", claim: claimText }],
      status: "ok",
    };

    const events: TraceEventInput[] = [];
    const verdict = await reviewDraft(
      {
        ...deps(critic, "critic-a", ledger),
        jev: fakeJevSupporting,
        blackboard: board,
        emit: (e) => events.push(e),
      },
      {
        subtask: subtask({ id: "s1", title: "Investigate finding" }),
        draft,
        producer: { role: "investigator", agentId: "investigator-1" },
        attempt: 1,
      },
    );

    expect(verdict.decision).toBe("REJECTED");
    if (verdict.decision !== "REJECTED") {
      throw new Error("Expected REJECTED verdict");
    }
    expect(verdict.verdict).toBe("rejected");
    expect(verdict.challenges).toHaveLength(10);
    const failed = verdict.challenges.find((c) => c.challenge === failedChallenge);
    expect(failed).toMatchObject({
      challenge: failedChallenge,
      outcome: "failed",
      reasoning: reason,
    });
    expect(verdict.newTask).toBeDefined();
    expect(events[0]).toMatchObject({ kind: "critic.verdict", verdict: "rejected" });
    expect(SharedCriticVerdict.safeParse(verdict).success).toBe(true);
    return verdict;
  };

  it("1. rejects when vulnerability does not apply (vulnerability_applies)", async () => {
    const v = await runChallengeTest(
      "vulnerability_applies",
      "Advisory applies to Python ecosystem, not npm package used in repository",
      "CVE-2024-0001 affects lodash",
    );
    expect(v.newTask.role).toBe("researcher");
  });

  it("2. rejects when vulnerable package is not present (package_present)", async () => {
    const v = await runChallengeTest(
      "package_present",
      "Package foo is not present in package.json or pnpm-lock.yaml",
      "foo 1.0.0 is installed",
    );
    expect(v.newTask.role).toBe("inventory");
  });

  it("3. rejects when affected functionality is unused (functionality_used)", async () => {
    const v = await runChallengeTest(
      "functionality_used",
      "foo.parse is never imported or referenced in codebase",
      "foo.parse is used in src/api",
    );
    expect(v.newTask.role).toBe("reachability");
  });

  it("4. rejects when affected code is unreachable (code_reachable)", async () => {
    const v = await runChallengeTest(
      "code_reachable",
      "No call-site analysis was performed to prove reachability from HTTP routes",
      "Vulnerable parser is reachable from public API",
    );
    expect(v.newTask.role).toBe("reachability");
    expect(v.newTask.title).toBe("Reachability analysis");
  });

  it("5. rejects when patched version is fabricated (patched_version_real)", async () => {
    const v = await runChallengeTest(
      "patched_version_real",
      "Version 9.9.9 does not exist on npm registry",
      "qs patched version is 9.9.9",
    );
    expect(v.newTask.role).toBe("researcher");
  });

  it("6. rejects when proposed upgrade is incompatible (upgrade_compatible)", async () => {
    const v = await runChallengeTest(
      "upgrade_compatible",
      "Major upgrade from 1.0.0 to 4.0.0 removes deprecated methods without migration",
      "Upgrade to 4.0.0 is drop-in compatible",
    );
    expect(v.newTask.role).toBe("impact");
  });

  it("7. rejects when sources contradict each other (sources_contradict)", async () => {
    const v = await runChallengeTest(
      "sources_contradict",
      "OSV lists fix in 2.4.0 while GitHub Advisory lists fix in 3.0.0",
      "Vulnerability fixed in 2.4.0",
    );
    expect(v.newTask.role).toBe("researcher");
  });

  it("8. rejects when evidence is stale (evidence_current)", async () => {
    const v = await runChallengeTest(
      "evidence_current",
      "Evidence references an outdated lockfile commit from 6 months ago",
      "Current dependency tree contains vulnerable transitive dep",
    );
    expect(v.newTask.role).toBe("researcher");
  });

  it("9. rejects when a safer mitigation exists (safer_mitigation)", async () => {
    const v = await runChallengeTest(
      "safer_mitigation",
      "Backported patch 1.2.4 is available without breaking changes of 3.0.0",
      "Only possible fix is major upgrade to 3.0.0",
    );
    expect(v.newTask.role).toBe("impact");
  });

  it("10. rejects when investigator makes an unsupported assumption (unsupported_assumption)", async () => {
    const v = await runChallengeTest(
      "unsupported_assumption",
      "Claim assumes remote code execution is possible without proving user input reaches sink",
      "Vulnerability allows remote code execution in this repo",
    );
    expect(v.newTask.role).toBe("researcher");
  });
});

describe("Hallucination Detection", () => {
  it("refutes a claim citing a version not in evidence and emits claim.refuted", async () => {
    const ledger = new ToolLedger();
    const board = new Blackboard();
    const events: TraceEventInput[] = [];

    const critic = scriptedAdapter([
      () =>
        result({
          decision: "REJECTED",
          findings: [],
        }),
    ]);

    const draft: Draft = {
      value: { package: "qs", latest: "9.9.9" },
      evidence: [
        {
          source: "npm",
          claim: "qs latest version is 9.9.9",
          quote: "dist-tags.latest = 9.9.9",
        },
      ],
      status: "ok",
    };

    const verdict = await reviewDraft(
      {
        ...deps(critic, "critic-a", ledger),
        jev: fakeJevRefuting,
        blackboard: board,
        emit: (e) => events.push(e),
        emitClaimEvents: true,
      },
      {
        subtask: subtask({ id: "s1" }),
        draft,
        producer: { role: "researcher", agentId: "researcher-1" },
        attempt: 1,
      },
    );

    expect(verdict.decision).toBe("REJECTED");
    expect(events.some((e) => e.kind === "claim.refuted")).toBe(true);
    const refuted = events.find((e) => e.kind === "claim.refuted");
    expect(refuted).toMatchObject({
      kind: "claim.refuted",
      claimId: "claim_0",
      verifier: { role: "critic", agentId: "critic-a" },
    });
  });

  it("refutes a claim citing a non-existent tool call", async () => {
    const ledger = new ToolLedger();
    const board = new Blackboard();
    const events: TraceEventInput[] = [];

    const critic = scriptedAdapter([
      () => result({ decision: "ACCEPTED", findings: [] }),
    ]);

    const draft: Draft = {
      value: { function: "foo.parse" },
      evidence: [
        {
          source: "trace",
          claim: "foo.parse is reachable",
          toolCallId: "call_nonexistent",
        },
      ],
      status: "ok",
    };

    const verdict = await reviewDraft(
      {
        ...deps(critic, "critic-a", ledger),
        jev: fakeJevSupporting,
        blackboard: board,
        emit: (e) => events.push(e),
        emitClaimEvents: true,
      },
      {
        subtask: subtask({ id: "s1" }),
        draft,
        producer: { role: "reachability", agentId: "reach-1" },
        attempt: 1,
      },
    );

    expect(verdict.decision).toBe("REJECTED");
    expect(events.some((e) => e.kind === "claim.refuted")).toBe(true);
  });

  it("verifies supported claims and emits claim.verified", async () => {
    const ledger = new ToolLedger();
    const board = new Blackboard();
    const events: TraceEventInput[] = [];

    const critic = scriptedAdapter([
      () =>
        result({
          decision: "ACCEPTED",
          challenges: CRITIC_CHALLENGE_IDS.map((id) => ({
            challenge: id,
            outcome: "survived",
            reasoning: "Valid evidence",
            evidenceIds: [],
          })),
          findings: [],
        }),
    ]);

    const draft: Draft = {
      value: { package: "qs", version: "6.13.0" },
      evidence: [{ source: "npm", claim: "qs version is 6.13.0" }],
      status: "ok",
    };

    const verdict = await reviewDraft(
      {
        ...deps(critic, "critic-a", ledger),
        jev: fakeJevSupporting,
        blackboard: board,
        emit: (e) => events.push(e),
        emitClaimEvents: true,
      },
      {
        subtask: subtask({ id: "s1" }),
        draft,
        producer: { role: "researcher", agentId: "researcher-1" },
        attempt: 1,
      },
    );

    expect(verdict.decision).toBe("ACCEPTED");
    expect(verdict.challenges.every((c) => c.outcome === "survived")).toBe(true);
    expect(events.some((e) => e.kind === "claim.verified")).toBe(true);
    const verified = events.find((e) => e.kind === "claim.verified");
    expect(verified).toMatchObject({
      kind: "claim.verified",
      claimId: "claim_0",
      verifier: { role: "critic", agentId: "critic-a" },
    });
  });
});
