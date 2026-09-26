import type { TraceEvent } from "@punch/shared";

/** What the operator needs beside the raw payload before answering an approval. */
export interface ApprovalContext {
  payload: string;
  action?: string;
  summary?: string;
  validation?: string;
  tests?: string;
  risk?: string;
  evidence?: string;
}

function bodyLine(payload: unknown, label: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = (payload as { body?: unknown }).body;
  if (typeof body !== "string") return undefined;
  for (const line of body.split("\n")) {
    if (line.startsWith(`${label}:`)) return line.slice(label.length + 1).trim();
  }
  return undefined;
}

/**
 * Join the approval payload with the run's own trace: the proposal event that
 * carries the approval id, and the sandbox result for the same finding. Every
 * field is only filled from what the trace or payload actually states.
 */
export function buildApprovalContext(
  events: readonly TraceEvent[],
  approval: { approvalId: string; payload: unknown },
): ApprovalContext {
  const context: ApprovalContext = { payload: JSON.stringify(approval.payload, null, 2) ?? "" };
  const proposal = events.find(
    (event) => event.kind === "remediation.proposed" && event.approvalId === approval.approvalId,
  );
  if (proposal && proposal.kind === "remediation.proposed") {
    context.action = proposal.action === "pull_request" ? "fix pull request" : "issue";
    context.summary = proposal.summary;
    const sandbox = events.find(
      (event) => event.kind === "sandbox.finished" && event.findingId === proposal.findingId,
    );
    if (sandbox && sandbox.kind === "sandbox.finished") {
      const validation = sandbox.validation;
      context.validation = [
        validation.verdict,
        `isolation ${validation.isolation}`,
        validation.newFailures.length > 0
          ? `${validation.newFailures.length} new failure(s)`
          : "no new failures",
      ].join(" · ");
      const counts = validation.candidate?.counts;
      context.tests = counts
        ? `${counts.passed}/${counts.total} passed, ${counts.failed} failed, ${counts.skipped} skipped`
        : "no tests ran";
      if (validation.evidenceIds.length > 0) context.evidence = validation.evidenceIds.join(", ");
    }
  }
  context.risk ??= bodyLine(approval.payload, "Upgrade impact");
  context.validation ??= bodyLine(approval.payload, "Sandbox validation");
  context.evidence ??= bodyLine(approval.payload, "Evidence");
  return context;
}
