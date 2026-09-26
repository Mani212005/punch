import type { RemediationProposal, SandboxValidation, TraceEvent } from "@punch/shared";
import type { ApprovalGate } from "../approval.js";
import type { GitHubClient, GitHubIssueResponse, GitHubPullResponse } from "../tools/github.js";
import { CompensationRegistry } from "./compensation.js";
import { openFixPr } from "./github-pr.js";
import { remediationProposedEvent } from "./proposal.js";

export interface RemediationTarget {
  owner: string;
  repo: string;
  /** Base branch for fix PRs. */
  base?: string;
  /** Fix branch to create for PRs. */
  branch?: string;
}

export interface RemediationExecutorDeps {
  github: GitHubClient;
  /** The A10 gate; `selectApprovalGate({ unattended: true })` denies everything. */
  approvalGate: ApprovalGate;
  trace?: { write(event: TraceEvent): unknown };
  runId?: string;
  seq?: number;
}

export type RemediationOutcome =
  | { status: "issue_created"; issue: GitHubIssueResponse; writes: 1 }
  | { status: "pr_opened"; pull: GitHubPullResponse; branch: string; writes: 1 }
  | { status: "denied"; writes: 0 }
  | { status: "human_review_required"; writes: 0; reason: string };

export interface ExecuteRemediationInput {
  proposal: RemediationProposal;
  target: RemediationTarget;
  sandbox?: SandboxValidation | null;
  validatedFiles?: Record<string, string>;
  signal?: AbortSignal;
  approvalId?: string;
}

function approvalTool(proposal: RemediationProposal): string {
  return proposal.action === "pull_request" ? "github_open_fix_pr" : "github_create_issue";
}

/**
 * Approval-gated remediation executor (E6).
 *
 * Traces `remediation.proposed`, asks the A10 approval gate, and only on
 * `approval.granted` performs exactly one GitHub write: an issue, or the
 * branch + commit + PR sequence with compensation. Denial performs no write.
 * `--unattended` reaches here as a denying gate, so it can never act.
 * A FAIL or NOT_RUN validation is never opened as a PR.
 */
export async function executeRemediation(
  deps: RemediationExecutorDeps,
  input: ExecuteRemediationInput,
): Promise<RemediationOutcome> {
  const runId = deps.runId ?? "run";
  const seq = deps.seq ?? 0;
  const { proposal, target } = input;
  const emit = async (event: TraceEvent) => {
    await deps.trace?.write(event);
  };

  await emit(remediationProposedEvent(runId, seq, proposal));

  if (proposal.validationVerdict !== "PASS" && proposal.action === "pull_request") {
    return {
      status: "human_review_required",
      writes: 0,
      reason: `validation ${proposal.validationVerdict}: DO NOT recommend automatic remediation. Human review required.`,
    };
  }

  const approvalId =
    input.approvalId ?? `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tool = approvalTool(proposal);
  const payload =
    proposal.action === "pull_request"
      ? {
          owner: target.owner,
          repo: target.repo,
          base: target.base ?? "main",
          branch: target.branch ?? `punch/fix-${proposal.dependency}-${proposal.to ?? "security"}`,
          title: proposal.title,
          body: proposal.body,
        }
      : { owner: target.owner, repo: target.repo, title: proposal.title, body: proposal.body };

  await emit({ runId, seq, ts: Date.now(), kind: "approval.requested", approvalId, tool, payload });

  const decision = await deps.approvalGate.requestApproval({
    approvalId,
    tool,
    payload,
    agentId: "executor",
  });

  if (!decision.approved) {
    await emit({
      runId,
      seq,
      ts: Date.now(),
      kind: "approval.denied",
      approvalId,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
    });
    return { status: "denied", writes: 0 };
  }

  await emit({
    runId,
    seq,
    ts: Date.now(),
    kind: "approval.granted",
    approvalId,
    decidedBy: decision.decidedBy,
  });

  if (proposal.action === "issue") {
    const res = await deps.github.createIssue(
      target.owner,
      target.repo,
      { title: proposal.title, body: proposal.body },
      input.signal,
    );
    return { status: "issue_created", issue: res.data, writes: 1 };
  }

  if (proposal.validationVerdict !== "PASS" || !input.sandbox) {
    return {
      status: "human_review_required",
      writes: 0,
      reason: `validation ${proposal.validationVerdict}: DO NOT recommend automatic remediation. Human review required.`,
    };
  }

  const registry = new CompensationRegistry(deps.trace, runId, seq);
  const result = await openFixPr(
    deps.github,
    {
      owner: target.owner,
      repo: target.repo,
      base: target.base ?? "main",
      branch: target.branch ?? `punch/fix-${proposal.dependency}-${proposal.to ?? "security"}`,
      title: proposal.title,
      body: proposal.body,
      sandbox: input.sandbox,
      validatedFiles: input.validatedFiles ?? {},
      signal: input.signal,
    },
    registry,
  );
  return { status: "pr_opened", pull: result.pull, branch: result.branch, writes: 1 };
}
