"use client";

import React from "react";
import type { InvestigationReport } from "@punch/shared";
import type { ApprovalItem, RemediationProposal, SandboxRunBoardState } from "@/lib/trace/types";

interface ApprovalCardTileProps {
  remediations: RemediationProposal[];
  approvals: ApprovalItem[];
  sandboxRuns: Record<string, SandboxRunBoardState>;
  report: InvestigationReport | null;
}

function approvalFor(
  approvals: ApprovalItem[],
  remediation: RemediationProposal,
): ApprovalItem | null {
  if (remediation.approvalId) {
    const direct = approvals.find((a) => a.approvalId === remediation.approvalId);
    if (direct) return direct;
  }
  const pending = approvals.filter((a) => a.status === "pending");
  return pending.length > 0 ? pending[pending.length - 1] : null;
}

function statusChipClass(status: ApprovalItem["status"]): string {
  if (status === "granted") return "done";
  if (status === "denied") return "fail";
  return "warn";
}

export default function ApprovalCardTile({
  remediations,
  approvals,
  sandboxRuns,
  report,
}: ApprovalCardTileProps) {
  const findingById = new Map((report?.findings ?? []).map((f) => [f.id, f]));
  const orphanApprovals = approvals.filter(
    (a) => !remediations.some((r) => r.approvalId === a.approvalId),
  );

  if (remediations.length === 0 && orphanApprovals.length === 0) {
    return (
      <div className="bz-tile c12" data-testid="approval-card">
        <div className="bz-label">proposed action · approval</div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          No remediation proposed yet. The executor proposes the issue or fix PR here, with
          validation, tests, risk and evidence, and waits for a human.
        </div>
      </div>
    );
  }

  return (
    <div className="bz-tile c12" style={{ gap: "10px" }} data-testid="approval-card">
      <div className="bz-label">proposed action · approval</div>
      {remediations.map((remediation, i) => {
        const approval = approvalFor(approvals, remediation);
        const pending = approval?.status === "pending";
        const sandbox = sandboxRuns[remediation.findingId]?.validation;
        const finding = findingById.get(remediation.findingId);
        const evidenceCount =
          finding?.claimIds.length ??
          report?.claims.filter((c) => c.findingId === remediation.findingId).length ??
          0;
        return (
          <div
            key={`${remediation.findingId}-${i}`}
            style={{
              border: "2px solid var(--bz-ink)",
              borderColor: pending ? "var(--bz-yellow)" : "var(--bz-ink)",
              boxShadow: pending ? "inset 0 0 0 2px var(--bz-yellow)" : "none",
              borderRadius: "10px",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
            data-testid={`remediation-${remediation.findingId}`}
          >
            <div className="bz-label">proposed action</div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "14px" }}>
                {remediation.action === "pull_request" ? "Open fix PR" : "File GitHub issue"}
              </strong>
              <span className="bz-mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>
                {remediation.dependency} {remediation.from} → {remediation.to ?? "unknown"}
              </span>
              {approval && (
                <span className={`bz-chip ${statusChipClass(approval.status)}`}>
                  {approval.status}
                </span>
              )}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "8px",
              }}
            >
              <div>
                <div className="bz-label" style={{ fontSize: "9px" }}>
                  validation
                </div>
                <div className="bz-mono" style={{ fontSize: "12px" }}>
                  {sandbox ? sandbox.verdict : "not run yet"}
                </div>
              </div>
              <div>
                <div className="bz-label" style={{ fontSize: "9px" }}>
                  tests
                </div>
                <div className="bz-num" style={{ fontSize: "12px" }}>
                  {sandbox?.candidate?.counts
                    ? `${sandbox.candidate.counts.passed}/${sandbox.candidate.counts.total}`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="bz-label" style={{ fontSize: "9px" }}>
                  risk
                </div>
                <div className="bz-mono" style={{ fontSize: "12px" }}>
                  {finding?.upgradeImpact ? finding.upgradeImpact.level : "unknown"}
                </div>
              </div>
              <div>
                <div className="bz-label" style={{ fontSize: "9px" }}>
                  evidence
                </div>
                <div className="bz-num" style={{ fontSize: "12px" }}>
                  {evidenceCount} {evidenceCount === 1 ? "claim" : "claims"}
                </div>
              </div>
            </div>
            <div className="bz-muted" style={{ fontSize: "12px" }}>
              {remediation.summary}
            </div>
            {pending && approval && (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                <span className="bz-label" style={{ fontSize: "9px" }}>
                  waiting on human
                </span>
                <span className="bz-btn primary sm" aria-disabled="true">
                  Approve
                </span>
                <span className="bz-btn danger sm" aria-disabled="true">
                  Reject
                </span>
                <span className="bz-mono bz-muted" style={{ fontSize: "10px" }}>
                  approve in the console or with punch approve {approval.approvalId}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {orphanApprovals.map((approval) => (
        <div
          key={approval.approvalId}
          className="bz-mono bz-muted"
          style={{ fontSize: "11px", overflowWrap: "anywhere" }}
        >
          approval {approval.approvalId} · {approval.tool} · {approval.status}
        </div>
      ))}
    </div>
  );
}
