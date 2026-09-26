import type { InvestigationReport, InvestigationFinding } from "@punch/shared";

import type { EvidenceLedger } from "./index.js";

export class ReportRenderer {
  constructor(private readonly ledger: EvidenceLedger) {}

  buildReport(
    repository: string,
    dependenciesAnalyzed: number,
    knownVulnerabilities: number,
    findings: InvestigationFinding[],
  ): InvestigationReport {
    let investigated = 0;
    let relevantReachable = 0;
    let validatedActionable = 0;
    let requiresHumanReview = 0;

    for (const f of findings) {
      investigated++;
      if (f.reachability.verdict === "REACHABLE") {
        relevantReachable++;
      }
      if (f.sandbox?.verdict === "PASS") {
        validatedActionable++;
      } else if (f.sandbox?.verdict === "FAIL" || f.sandbox?.verdict === "NOT_RUN") {
        requiresHumanReview++;
      }
    }

    const summary = {
      repository,
      dependenciesAnalyzed,
      knownVulnerabilities,
      investigated,
      relevantReachable,
      validatedActionable,
      requiresHumanReview,
    };

    return {
      summary,
      findings,
      claims: this.ledger.getAllClaims(),
      evidence: this.ledger.getAllEvidence(),
    };
  }

  renderMarkdown(report: InvestigationReport): string {
    const s = report.summary;
    let md = `PUNCH SECURITY INVESTIGATION

Repository:
${s.repository}

Dependencies analyzed:
${s.dependenciesAnalyzed}

Known vulnerabilities:
${s.knownVulnerabilities}

Investigated:
${s.investigated}

Relevant/reachable:
${s.relevantReachable}

Validated as actionable:
${s.validatedActionable}

Requires human review:
${s.requiresHumanReview}
`;

    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i]!;
      md += `\n--------------------------------\n\nFinding #${i + 1}\n\n`;
      md += `Dependency:\n${f.dependency} ${f.version}\n\n`;
      md += `Vulnerability:\n${f.advisoryIds.join(", ")}\n\n`;
      md += `Severity:\n${f.severity}\n\n`;
      md += `Reachability:\n${f.reachability.verdict}\n\n`;

      const evidence = this.renderEvidence(f, report);
      md += `Evidence:\n${evidence}\n\n`;

      const toVer = f.upgrade.to || "N/A";
      md += `Upgrade:\n${f.upgrade.from} → ${toVer}\n\n`;
      md += `Upgrade impact:\n${f.upgradeImpact?.level || "UNKNOWN"}\n\n`;
      md += `Sandbox validation:\n${f.sandbox?.verdict || "NOT_RUN"}\n\n`;
      md += `Critic:\n${f.critic}\n\n`;
      const actionStr =
        f.recommendedAction === "UPGRADE" ? "Upgrade to " + toVer : f.recommendedAction;
      md += `Recommended action:\n${actionStr}\n\n`;

      md += `[Create GitHub Issue]\n[Create Fix PR]\n`;
    }

    return md;
  }

  private renderEvidence(finding: InvestigationFinding, report: InvestigationReport): string {
    // Collect claims related to this finding
    const claimIds = new Set([
      ...finding.claimIds,
      ...finding.reachability.claimIds,
      ...(finding.upgradeImpact?.claimIds || []),
    ]);

    const relevantClaims = report.claims.filter(
      (c) => claimIds.has(c.id) && c.status === "verified",
    );
    if (relevantClaims.length === 0) return "No verified evidence available.";

    const lines: string[] = [];
    const usedEvidence = new Set<string>();

    for (const c of relevantClaims) {
      for (const ref of c.evidenceRefs) {
        if (!usedEvidence.has(ref)) {
          usedEvidence.add(ref);
          const e = report.evidence.find((ev) => ev.id === ref);
          if (e) {
            lines.push(`✓ ${e.ref} (${e.kind})`);
          } else {
            lines.push(`✓ ${ref} (unknown)`);
          }
        }
      }
    }
    return lines.length > 0 ? lines.join("\n") : "No verified evidence available.";
  }
}
