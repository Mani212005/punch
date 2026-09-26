"use client";

import React from "react";
import type { InvestigationFinding } from "@punch/shared";
import type { BlackboardEntry, CriticVerdictItem } from "@/lib/trace/types";
import { findInvestigationReport } from "@/lib/trace/investigation";

interface InvestigationReportTileProps {
  blackboard: Record<string, BlackboardEntry>;
  criticVerdicts: CriticVerdictItem[];
}

function SummaryCount({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "2px solid var(--bz-ink)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        minWidth: 0,
      }}
    >
      <span className="bz-num" style={{ fontSize: "22px", fontWeight: 700 }}>
        {value}
      </span>
      <span className="bz-label" style={{ fontSize: "9px" }}>
        {label}
      </span>
    </div>
  );
}

function reachabilityChipClass(verdict: InvestigationFinding["reachability"]["verdict"]): string {
  if (verdict === "REACHABLE") return "run";
  if (verdict === "NOT_REACHABLE") return "done";
  return "warn";
}

function sandboxChipClass(verdict: "PASS" | "FAIL" | "NOT_RUN" | "PENDING"): string {
  if (verdict === "PASS") return "done";
  if (verdict === "FAIL") return "fail";
  return "warn";
}

function criticChipClass(verdict: InvestigationFinding["critic"]): string {
  if (verdict === "ACCEPTED") return "done";
  if (verdict === "REJECTED") return "fail";
  return "ghost";
}

function FindingTile({ finding, index }: { finding: InvestigationFinding; index: number }) {
  const sandboxVerdict = finding.sandbox?.verdict ?? "NOT_RUN";
  const upgradeTo = finding.upgrade.to ?? "no patched version known";
  return (
    <div
      style={{
        border: "2px solid var(--bz-ink)",
        borderRadius: "10px",
        background: "var(--bz-paper-2)",
        padding: "14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
      data-testid={`finding-${finding.id}`}
    >
      <div className="bz-label">
        finding #{index + 1} · {finding.id}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "8px",
        }}
      >
        <div>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            dependency
          </div>
          <div className="bz-mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>
            {finding.dependency} {finding.version}
          </div>
          <div className="bz-mono bz-muted" style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
            {finding.advisoryIds.join(" · ")}
          </div>
        </div>
        <div>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            severity
          </div>
          <span className="bz-chip">{finding.severity}</span>
        </div>
        <div>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            reachability
          </div>
          <span className={`bz-chip ${reachabilityChipClass(finding.reachability.verdict)}`}>
            {finding.reachability.verdict}
          </span>
          <div className="bz-mono bz-muted" style={{ fontSize: "11px", marginTop: "4px" }}>
            exists {finding.reachability.exists} · exposed {finding.reachability.exposed} ·
            exploitable {finding.reachability.exploitable}
          </div>
          {finding.reachability.affectedSymbols.length > 0 && (
            <div className="bz-mono" style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              {finding.reachability.affectedSymbols.join(", ")}
            </div>
          )}
        </div>
        <div id={index === 0 ? "impact" : undefined}>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            upgrade
          </div>
          <div className="bz-mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>
            {finding.upgrade.from} → {upgradeTo}
          </div>
          <div style={{ marginTop: "4px", display: "flex", gap: "6px", alignItems: "center" }}>
            <span className="bz-label" style={{ fontSize: "9px" }}>
              impact
            </span>
            <span className="bz-chip">{finding.upgradeImpact?.level ?? "UNKNOWN"}</span>
          </div>
        </div>
        <div>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            sandbox validation
          </div>
          <span className={`bz-chip ${sandboxChipClass(sandboxVerdict)}`}>
            {sandboxVerdict.replace("_", " ")}
          </span>
        </div>
        <div id={index === 0 ? "critic" : undefined}>
          <div className="bz-label" style={{ fontSize: "9px" }}>
            critic
          </div>
          <span className={`bz-chip ${criticChipClass(finding.critic)}`}>{finding.critic}</span>
        </div>
      </div>
      <div
        style={{
          borderTop: "2px solid var(--bz-ink)",
          paddingTop: "8px",
          display: "flex",
          gap: "8px",
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span className="bz-label" style={{ fontSize: "9px" }}>
          recommended action
        </span>
        <strong style={{ fontSize: "13px" }}>{finding.recommendedAction}</strong>
        {finding.reasoning && (
          <span className="bz-muted" style={{ fontSize: "12px" }}>
            {finding.reasoning}
          </span>
        )}
      </div>
    </div>
  );
}

export default function InvestigationReportTile({
  blackboard,
  criticVerdicts,
}: InvestigationReportTileProps) {
  const report = findInvestigationReport(blackboard);

  if (!report) {
    return (
      <div className="bz-tile c12" data-testid="investigation-report">
        <div className="bz-label">security investigation report</div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          No investigation report on the blackboard yet. The investigator writes it when the
          evidence streams are in.
        </div>
      </div>
    );
  }

  const rejected = criticVerdicts.filter((v) => v.verdict === "rejected").length;

  return (
    <div
      className="bz-tile c12"
      style={{ gap: "10px" }}
      id="reachability"
      data-testid="investigation-report"
    >
      <div className="bz-label">security investigation report · {report.summary.repository}</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: "8px",
        }}
      >
        <SummaryCount label="dependencies analyzed" value={report.summary.dependenciesAnalyzed} />
        <SummaryCount label="known vulnerabilities" value={report.summary.knownVulnerabilities} />
        <SummaryCount label="investigated" value={report.summary.investigated} />
        <SummaryCount label="relevant / reachable" value={report.summary.relevantReachable} />
        <SummaryCount label="validated actionable" value={report.summary.validatedActionable} />
        <SummaryCount label="human review" value={report.summary.requiresHumanReview} />
      </div>
      {rejected > 0 && (
        <div className="bz-mono bz-muted" style={{ fontSize: "11px" }}>
          critic rejected {rejected} {rejected === 1 ? "verdict" : "verdicts"} in this run; each
          rejection replanned before acceptance.
        </div>
      )}
      {report.findings.map((finding, i) => (
        <FindingTile key={finding.id} finding={finding} index={i} />
      ))}
    </div>
  );
}
