import { describe, it, expect } from "vitest";
import { EvidenceLedger, ReportRenderer } from "./index.js";
import type {
  Claim,
  EvidenceRecord,
  TraceEvent,
  InvestigationFinding} from "@punch/shared";


describe("EvidenceLedger", () => {
  it("should record and query evidence and claims", () => {
    const emitted: TraceEvent[] = [];
    const sink = (e: TraceEvent) => { emitted.push(e); };
    const ledger = new EvidenceLedger("run-1", sink, () => 1000);

    const ev1: EvidenceRecord = {
      id: "ev-1",
      kind: "file",
      ref: "src/index.ts",
      excerpt: "import { foo } from 'bar';",
      fetchedAt: 1000,
      tool: "github_contents",
    };

    ledger.recordEvidence({ role: "reachability", agentId: "agent-1", subtaskId: "task-1" }, ev1);

    expect(emitted.length).toBe(1);
    expect(emitted[0]?.kind).toBe("evidence.recorded");
    expect(ledger.getEvidence("ev-1")).toEqual(ev1);

    const claim1: Claim = {
      id: "c-1",
      findingId: "f-1",
      kind: "reachability",
      text: "foo is imported",
      author: { role: "reachability", agentId: "agent-1" },
      evidenceRefs: ["ev-1"],
      status: "proposed",
      verifier: null,
    };

    ledger.recordClaim(claim1);
    expect(emitted.length).toBe(2);
    expect(emitted[1]?.kind).toBe("claim.recorded");
    expect(ledger.getClaim("c-1")).toEqual(claim1);
    expect(ledger.getClaimsByFinding("f-1")).toHaveLength(1);
    expect(ledger.getClaimsByAuthor("agent-1")).toHaveLength(1);
  });

  it("should handle verification transitions", () => {
    const ledger = new EvidenceLedger("run-1");

    const claim: Claim = {
      id: "c-1",
      findingId: "f-1",
      kind: "reachability",
      text: "foo is imported",
      author: { role: "reachability", agentId: "agent-1" },
      evidenceRefs: ["ev-1"],
      status: "proposed",
      verifier: null,
    };
    ledger.recordClaim(claim);

    ledger.verifyClaim("c-1", { role: "critic", agentId: "critic-1" }, "looks good");
    const updated = ledger.getClaim("c-1")!;
    expect(updated.status).toBe("verified");
    expect(updated.verifier).toEqual({ role: "critic", agentId: "critic-1" });
    expect(updated.rationale).toBe("looks good");
    expect(ledger.getClaimsByVerifier("critic-1")).toHaveLength(1);

    ledger.refuteClaim("c-1", { role: "investigator", agentId: "inv-1" }, "actually no");
    expect(updated.status).toBe("refuted");
    expect(updated.verifier).toEqual({ role: "investigator", agentId: "inv-1" });
    expect(updated.rationale).toBe("actually no");
  });

  it("should extract handoff slice", () => {
    const ledger = new EvidenceLedger("run-1");

    const ev1: EvidenceRecord = {
      id: "ev-1",
      kind: "file",
      ref: "f1",
      excerpt: "",
      fetchedAt: 0,
    };
    const ev2: EvidenceRecord = {
      id: "ev-2",
      kind: "api_response",
      ref: "api1",
      excerpt: "",
      fetchedAt: 0,
    };

    ledger.recordEvidence({ role: "researcher", subtaskId: "task-1" }, ev1);
    ledger.recordEvidence({ role: "researcher", subtaskId: "task-2" }, ev2);

    const slice = ledger.getHandoffEvidence("task-1");
    expect(slice).toHaveLength(1);
    expect(slice[0]?.id).toBe("ev-1");
  });
});

describe("ReportRenderer", () => {
  it("should render a golden report", () => {
    const ledger = new EvidenceLedger("run-1");
    const renderer = new ReportRenderer(ledger);

    ledger.recordEvidence(
      { role: "reachability" },
      { id: "ev-1", kind: "file", ref: "src/api.ts", excerpt: "import foo", fetchedAt: 0 }
    );
    ledger.recordClaim({
      id: "c-1",
      findingId: "f-1",
      kind: "reachability",
      text: "imported in api",
      author: { role: "reachability" },
      evidenceRefs: ["ev-1"],
      status: "verified",
      verifier: { role: "critic" }
    });

    const findings: InvestigationFinding[] = [
      {
        id: "f-1",
        dependency: "foo",
        version: "2.1.4",
        advisoryIds: ["CVE-XXXX"],
        severity: "HIGH",
        reachability: {
          verdict: "REACHABLE",
          exists: "yes",
          exposed: "yes",
          exploitable: "unknown",
          summary: "imported in api",
          claimIds: ["c-1"],
          affectedSymbols: []
        },
        upgrade: { from: "2.1.4", to: "2.4.0" },
        upgradeImpact: { level: "LOW", detectedRisks: [], unknowns: [], claimIds: [] },
        sandbox: {
          isolation: "docker",
          baseline: null,
          candidate: null,
          newFailures: [],
          fixedFailures: [],
          verdict: "PASS",
          evidenceIds: []
        },
        critic: "ACCEPTED",
        recommendedAction: "UPGRADE",
        claimIds: []
      }
    ];

    const report = renderer.buildReport("example/repo", 143, 12, findings);

    expect(report.summary.investigated).toBe(1);
    expect(report.summary.relevantReachable).toBe(1);
    expect(report.summary.validatedActionable).toBe(1);
    expect(report.summary.requiresHumanReview).toBe(0);

    const md = renderer.renderMarkdown(report);
    
    // Check key strings from the golden format
    expect(md).toContain("PUNCH SECURITY INVESTIGATION");
    expect(md).toContain("Repository:\nexample/repo");
    expect(md).toContain("Dependencies analyzed:\n143");
    expect(md).toContain("Known vulnerabilities:\n12");
    expect(md).toContain("Validated as actionable:\n1");
    expect(md).toContain("Finding #1");
    expect(md).toContain("Dependency:\nfoo 2.1.4");
    expect(md).toContain("Vulnerability:\nCVE-XXXX");
    expect(md).toContain("Reachability:\nREACHABLE");
    expect(md).toContain("✓ src/api.ts (file)");
    expect(md).toContain("Upgrade:\n2.1.4 → 2.4.0");
    expect(md).toContain("Sandbox validation:\nPASS");
    expect(md).toContain("Recommended action:\nUpgrade to 2.4.0");
    expect(md).toContain("[Create GitHub Issue]");
  });
});
