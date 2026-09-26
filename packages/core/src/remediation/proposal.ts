import type {
  InvestigationFinding,
  RemediationAction,
  RemediationProposal,
  SandboxValidation,
  TraceEvent,
} from "@punch/shared";

/** Only manifest and lockfile paths the E5 sandbox diffs may be committed by the executor. */
const MANIFEST_ALLOWLIST = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
]);

export function isAllowedManifestFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return MANIFEST_ALLOWLIST.has(base);
}

export interface ProposalInput {
  finding: InvestigationFinding;
  /** Sandbox result the proposal must show; absent means NOT_RUN. */
  sandbox?: SandboxValidation | null;
  /** Repo-relative file contents for the validated manifest/lockfile diff. */
  validatedFiles?: Record<string, string>;
  criticVerdict?: "ACCEPTED" | "REJECTED" | "PENDING";
  evidenceIds?: string[];
}

function validationSummaryText(finding: InvestigationFinding, sandbox: SandboxValidation): string {
  const candidate = sandbox.candidate;
  const counts = candidate?.counts;
  const tests = counts ? `${counts.passed}/${counts.total}` : "no test counts";
  return [
    `Upgrade: ${finding.dependency} ${finding.upgrade.from} -> ${finding.upgrade.to ?? "unknown"}`,
    `Validation: ${sandbox.verdict}`,
    `Tests: ${tests}`,
    `Risk: ${finding.upgradeImpact?.level ?? "unknown"}`,
  ].join("\n");
}

function testSummaryText(sandbox: SandboxValidation): string {
  const candidate = sandbox.candidate;
  if (!candidate?.counts) return "no tests ran";
  const { total, passed, failed, skipped } = candidate.counts;
  return `${passed}/${total} passed, ${failed} failed, ${skipped} skipped`;
}

function findingBody(finding: InvestigationFinding, sandbox: SandboxValidation): string {
  const lines = [
    `Dependency: ${finding.dependency} ${finding.version}`,
    `Vulnerability: ${finding.advisoryIds.join(", ")}`,
    `Severity: ${finding.severity}`,
    ``,
    `Reachability: ${finding.reachability.verdict}`,
    finding.reachability.summary,
    ``,
    `Upgrade: ${finding.upgrade.from} -> ${finding.upgrade.to ?? "unknown"}`,
    `Upgrade impact: ${finding.upgradeImpact?.level ?? "unknown"}`,
    ...(finding.upgradeImpact?.detectedRisks ?? []).map((r) => `- risk: ${r}`),
    ...(finding.upgradeImpact?.unknowns ?? []).map((u) => `- unknown: ${u}`),
    ``,
    `Sandbox validation: ${sandbox.verdict}`,
    sandbox.note ?? "",
    sandbox.newFailures.length > 0
      ? `New failures: ${sandbox.newFailures.join(", ")}`
      : "New failures: none",
    ``,
    `Critic: ${finding.critic}`,
    finding.reasoning ?? "",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

/**
 * Build the exact proposed action for one finding (docs/investigation.md sections 8-9).
 *
 * A sandbox verdict other than PASS is never offered as a PR: the proposal becomes
 * an issue marked "human review required" (plan.md 8.7, decision 11).
 */
export function buildProposal(input: ProposalInput): RemediationProposal {
  const { finding } = input;
  const sandbox: SandboxValidation = input.sandbox ?? {
    isolation: "none",
    note: "not run (no isolation available)",
    baseline: null,
    candidate: null,
    newFailures: [],
    fixedFailures: [],
    changedFiles: [],
    verdict: "NOT_RUN",
    evidenceIds: [],
  };
  const passes = sandbox.verdict === "PASS";
  const hasTarget = finding.upgrade.to !== null;
  const action: RemediationAction = passes && hasTarget ? "pull_request" : "issue";
  const humanReviewRequired = !passes;
  const risk = finding.upgradeImpact?.level ?? "HIGH";

  const upgradeLine =
    action === "pull_request"
      ? `Upgrade to ${finding.upgrade.to}`
      : `human review required (validation ${sandbox.verdict})`;

  const title =
    action === "pull_request"
      ? `fix(security): upgrade ${finding.dependency} ${finding.upgrade.from} -> ${finding.upgrade.to}`
      : `[security] ${finding.dependency} ${finding.version} (${finding.advisoryIds.join(", ")}): human review required`;

  const body = [
    findingBody(finding, sandbox),
    ``,
    `Recommended action:`,
    upgradeLine,
    humanReviewRequired ? `DO NOT recommend automatic remediation. Human review required.` : ``,
    ``,
    `Evidence: ${(input.evidenceIds ?? finding.claimIds).join(", ") || "see ledger"}`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  return {
    findingId: finding.id,
    action,
    dependency: finding.dependency,
    from: finding.upgrade.from,
    to: finding.upgrade.to,
    title,
    body,
    validationSummary: validationSummaryText(finding, sandbox),
    validationVerdict: sandbox.verdict,
    testSummary: testSummaryText(sandbox),
    risk,
    evidenceIds: input.evidenceIds ?? [...finding.claimIds],
    criticVerdict: input.criticVerdict ?? finding.critic,
    humanReviewRequired,
  };
}

/** Trace the proposal before any approval request (plan.md 8.7 `remediation.proposed`). */
export function remediationProposedEvent(
  runId: string,
  seq: number,
  proposal: RemediationProposal,
  summary?: string,
): TraceEvent {
  return {
    runId,
    seq,
    ts: Date.now(),
    kind: "remediation.proposed",
    findingId: proposal.findingId,
    action: proposal.action === "pull_request" ? "pull_request" : "issue",
    dependency: proposal.dependency,
    from: proposal.from,
    to: proposal.to,
    summary: summary ?? proposal.validationSummary,
  };
}

/** Files the PR sequence may commit: exactly the validated manifest/lockfile diff. */
export function validatedManifestFiles(
  sandbox: SandboxValidation,
  validatedFiles: Record<string, string> | undefined,
): Record<string, string> {
  const changed = sandbox.changedFiles.filter(isAllowedManifestFile);
  const out: Record<string, string> = {};
  for (const file of changed) {
    const content = validatedFiles?.[file];
    if (typeof content === "string") out[file] = content;
  }
  return out;
}
