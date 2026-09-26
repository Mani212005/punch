import { z } from "zod";
import { SlotRole } from "./common.js";

/**
 * Security investigation contract (docs/investigation.md, plan.md section 8).
 * The critic's per-claim `Finding` in handoff.ts is a different, older type; the
 * investigation result for one dependency vulnerability is `InvestigationFinding`.
 */

/** Who authored or verified a claim: an LLM slot, or the code-driven sandbox validator. */
export const ClaimActor = z.object({
  role: z.union([SlotRole, z.literal("validator")]),
  /** Absent for the validator, which is code and not a configured agent. */
  agentId: z.string().optional(),
});
export type ClaimActor = z.infer<typeof ClaimActor>;

export const EvidenceKind = z.enum([
  "file",
  "tool_result",
  "api_response",
  "static_search",
  "dependency_graph",
  "sandbox_run",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** One citable piece of evidence: a file, a tool result, a static search, a sandbox run. */
export const EvidenceRecord = z.object({
  id: z.string(),
  kind: EvidenceKind,
  /** File path, URL, tool call id, search query, or sandbox run id. */
  ref: z.string(),
  excerpt: z.string(),
  fetchedAt: z.number(),
  /** Tool that produced it, so the report can say which tools were called. */
  tool: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const ClaimKind = z.enum([
  "presence",
  "affected_symbol",
  "reachability",
  "exposure",
  "patched_version",
  "upgrade_compat",
  "sandbox",
  "mitigation",
  "other",
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimStatus = z.enum(["proposed", "verified", "refuted", "unsupported"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Evidence ledger entry: who claimed what, on which evidence, who verified it. */
export const Claim = z.object({
  id: z.string(),
  text: z.string(),
  kind: ClaimKind,
  /** Id of the InvestigationFinding this claim is about. */
  findingId: z.string(),
  author: ClaimActor,
  evidenceRefs: z.array(z.string()),
  status: ClaimStatus,
  verifier: ClaimActor.nullable(),
  /** Why the claim was accepted, refuted, or left unsupported. */
  rationale: z.string().optional(),
});
export type Claim = z.infer<typeof Claim>;

export const ReachabilityVerdict = z.enum(["REACHABLE", "NOT_REACHABLE", "UNKNOWN"]);
export type ReachabilityVerdict = z.infer<typeof ReachabilityVerdict>;

/** exists != exposed != exploitable (docs/investigation.md section 2A). */
export const LevelAssessment = z.enum(["yes", "no", "unknown"]);
export type LevelAssessment = z.infer<typeof LevelAssessment>;

export const Reachability = z.object({
  verdict: ReachabilityVerdict,
  exists: LevelAssessment,
  exposed: LevelAssessment,
  exploitable: LevelAssessment,
  affectedSymbols: z.array(z.string()).default([]),
  claimIds: z.array(z.string()).default([]),
  summary: z.string(),
});
export type Reachability = z.infer<typeof Reachability>;

export const ImpactLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type ImpactLevel = z.infer<typeof ImpactLevel>;

/** LOW / MEDIUM / HIGH with evidence, never an invented percentage. */
export const UpgradeImpact = z.object({
  level: ImpactLevel,
  detectedRisks: z.array(z.string()),
  unknowns: z.array(z.string()),
  claimIds: z.array(z.string()).default([]),
});
export type UpgradeImpact = z.infer<typeof UpgradeImpact>;

export const SandboxIsolation = z.enum(["docker", "host", "none"]);
export type SandboxIsolation = z.infer<typeof SandboxIsolation>;

export const SandboxStepStatus = z.enum(["pass", "fail", "skipped", "not_run"]);
export type SandboxStepStatus = z.infer<typeof SandboxStepStatus>;

export const SandboxStepName = z.enum(["install", "build", "test"]);
export type SandboxStepName = z.infer<typeof SandboxStepName>;

export const SandboxStepResult = z.object({
  status: SandboxStepStatus,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  /** Tail of combined output, for the ledger. */
  logTail: z.string().default(""),
});
export type SandboxStepResult = z.infer<typeof SandboxStepResult>;

export const TestCounts = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().default(0),
});
export type TestCounts = z.infer<typeof TestCounts>;

export const SandboxRunResult = z.object({
  install: SandboxStepResult,
  build: SandboxStepResult,
  test: SandboxStepResult,
  counts: TestCounts.nullable(),
  failingTests: z.array(z.string()).default([]),
});
export type SandboxRunResult = z.infer<typeof SandboxRunResult>;

export const SandboxVerdict = z.enum(["PASS", "FAIL", "NOT_RUN"]);
export type SandboxVerdict = z.infer<typeof SandboxVerdict>;

/**
 * Baseline (before) versus candidate (after upgrade) run. `isolation: "none"` with
 * verdict NOT_RUN means no isolation was available and nothing was executed on the host.
 */
export const SandboxValidation = z.object({
  isolation: SandboxIsolation,
  /** Human-readable explanation, e.g. "not run (no isolation available)". */
  note: z.string().optional(),
  baseline: SandboxRunResult.nullable(),
  candidate: SandboxRunResult.nullable(),
  /** Tests failing in candidate but passing in baseline. */
  newFailures: z.array(z.string()).default([]),
  /** Tests failing in baseline and fixed in candidate. */
  fixedFailures: z.array(z.string()).default([]),
  /** Repo-relative files that differ between the baseline and candidate copies (manifest and lockfile). */
  changedFiles: z.array(z.string()).default([]),
  /** Unified diff of the changed files, truncated. */
  diff: z.string().optional(),
  verdict: SandboxVerdict,
  evidenceIds: z.array(z.string()).default([]),
});
export type SandboxValidation = z.infer<typeof SandboxValidation>;

/** The ten adversarial questions (docs/investigation.md section 5), in order. */
export const CRITIC_CHALLENGE_IDS = [
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
] as const;
export const CriticChallengeId = z.enum(CRITIC_CHALLENGE_IDS);
export type CriticChallengeId = z.infer<typeof CriticChallengeId>;

export const CriticChallengeOutcome = z.enum(["survived", "failed", "not_applicable"]);
export type CriticChallengeOutcome = z.infer<typeof CriticChallengeOutcome>;

export const CriticChallengeResult = z.object({
  challenge: CriticChallengeId,
  outcome: CriticChallengeOutcome,
  reasoning: z.string(),
  evidenceIds: z.array(z.string()).default([]),
});
export type CriticChallengeResult = z.infer<typeof CriticChallengeResult>;

/** A rejection names the missing evidence and the targeted task the planner must create. */
export const NewTaskRequest = z.object({
  role: SlotRole,
  title: z.string(),
  description: z.string(),
  /** Claims the new task must support or re-examine. */
  claimIds: z.array(z.string()).default([]),
});
export type NewTaskRequest = z.infer<typeof NewTaskRequest>;

export const CriticVerdict = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ACCEPTED"),
    findingId: z.string(),
    challenges: z.array(CriticChallengeResult),
  }),
  z.object({
    decision: z.literal("REJECTED"),
    findingId: z.string(),
    challenges: z.array(CriticChallengeResult),
    reason: z.string(),
    missingEvidence: z.array(z.string()),
    newTask: NewTaskRequest,
  }),
]);
export type CriticVerdict = z.infer<typeof CriticVerdict>;

export const Severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
export type Severity = z.infer<typeof Severity>;

export const RecommendedAction = z.enum([
  "UPGRADE",
  "MITIGATE",
  "NO_ACTION",
  "HUMAN_REVIEW",
  "MONITOR",
]);
export type RecommendedAction = z.infer<typeof RecommendedAction>;

/** One dependency vulnerability investigated end to end (report section 8, "Finding #n"). */
export const InvestigationFinding = z.object({
  id: z.string(),
  dependency: z.string(),
  version: z.string(),
  advisoryIds: z.array(z.string()).min(1),
  severity: Severity,
  reachability: Reachability,
  upgrade: z.object({ from: z.string(), to: z.string().nullable() }),
  upgradeImpact: UpgradeImpact.nullable(),
  sandbox: SandboxValidation.nullable(),
  critic: z.enum(["ACCEPTED", "REJECTED", "PENDING"]),
  recommendedAction: RecommendedAction,
  /** Rationale for the recommendation, in plain words. */
  reasoning: z.string().optional(),
  claimIds: z.array(z.string()).default([]),
});
export type InvestigationFinding = z.infer<typeof InvestigationFinding>;

export const ReportSummary = z.object({
  repository: z.string(),
  dependenciesAnalyzed: z.number().int().nonnegative(),
  knownVulnerabilities: z.number().int().nonnegative(),
  investigated: z.number().int().nonnegative(),
  relevantReachable: z.number().int().nonnegative(),
  validatedActionable: z.number().int().nonnegative(),
  requiresHumanReview: z.number().int().nonnegative(),
});
export type ReportSummary = z.infer<typeof ReportSummary>;

/** Section 8 report: counts plus findings, with the ledger that backs them. */
export const InvestigationReport = z.object({
  summary: ReportSummary,
  findings: z.array(InvestigationFinding),
  claims: z.array(Claim).default([]),
  evidence: z.array(EvidenceRecord).default([]),
});
export type InvestigationReport = z.infer<typeof InvestigationReport>;

/** Proposed external action the executor shows before the A10 approval gate (E6). */
export const RemediationAction = z.enum(["issue", "pull_request"]);
export type RemediationAction = z.infer<typeof RemediationAction>;

export const RemediationProposal = z.object({
  findingId: z.string(),
  action: RemediationAction,
  dependency: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  /** Exact external action: issue title/body or PR head/base/title/body. */
  title: z.string(),
  body: z.string(),
  /** Validation summary shown beside the approve/deny prompt (docs/investigation.md section 9). */
  validationSummary: z.string(),
  validationVerdict: SandboxVerdict,
  testSummary: z.string(),
  risk: ImpactLevel,
  evidenceIds: z.array(z.string()).default([]),
  criticVerdict: z.enum(["ACCEPTED", "REJECTED", "PENDING"]).default("PENDING"),
  /** FAIL/NOT_RUN proposals carry this instead of an auto-remediation recommendation. */
  humanReviewRequired: z.boolean().default(false),
});
export type RemediationProposal = z.infer<typeof RemediationProposal>;
