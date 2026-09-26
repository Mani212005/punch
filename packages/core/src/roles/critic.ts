import { z } from "zod";
import { Finding, type Evidence, type Subtask } from "@punch/shared";
import type { Blackboard } from "../blackboard.js";
import type { Jev } from "../router/jev.js";
import type { TraceEventInput } from "../trace/writer.js";
import { jsonSchemaOf, runRole, toolsForRole } from "./common.js";
import type { Draft, RoleDeps, ToolLedger } from "./common.js";

export interface CriticDeps extends RoleDeps {
  /** Jev pre-check, one Noul per claim. */
  jev: Pick<Jev, "precheckClaims">;
  /** Read-only: the critic never writes. */
  blackboard: Pick<Blackboard, "get" | "list">;
  ledger: ToolLedger;
  emit?: (event: TraceEventInput) => void;
  /** A claim is unsupported when Jev's probability of support is below this. */
  precheckThreshold?: number;
}

export interface CriticVerdict {
  verdict: "accepted" | "rejected";
  findings: Finding[];
}

export const CRITIC_SYSTEM = `You are the critic in a dependency security triage run. You check a candidate blackboard entry against evidence and reject what is not supported.

Rules:
- Verify every claim against its cited evidence. Use get_tool_result to read the recorded output of a cited tool call and read_blackboard for cited entries. You have read access only.
- Reject fabricated versions, advisories, or release notes; claims whose cited evidence does not say what the claim says; claims with no evidence; and any degraded or missing input presented as known.
- The Jev pre-check results are a signal, not a verdict: confirm or overrule each with your own reading.
- Each finding names the claim, what is wrong, and a severity (blocker rejects; warning and info do not).
- Submit exactly once with write_result: verdict "accepted" or "rejected" plus findings.`;

const CriticResult = z.object({
  verdict: z.enum(["accepted", "rejected"]),
  findings: z.array(Finding),
});

const MAX_EVIDENCE_CHARS = 4000;

function clip(text: string): string {
  return text.length > MAX_EVIDENCE_CHARS
    ? `${text.slice(0, MAX_EVIDENCE_CHARS)}...[truncated]`
    : text;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

/** The evidence text Jev judges a claim against: the cited quote plus what the cited source really holds. */
export function resolveEvidence(
  evidence: Evidence,
  deps: Pick<CriticDeps, "blackboard" | "ledger">,
): string {
  const parts: string[] = [];
  if (evidence.quote) parts.push(`Quote: ${evidence.quote}`);
  if (evidence.toolCallId) {
    const call = deps.ledger.toolCall(evidence.toolCallId);
    parts.push(
      call
        ? `Recorded output of ${call.tool} (${evidence.toolCallId}): ${clip(stringify(call.output))}`
        : `No tool call ${evidence.toolCallId} exists in the trace.`,
    );
  }
  const key = evidence.source.startsWith("blackboard:")
    ? evidence.source.slice("blackboard:".length)
    : undefined;
  if (key) {
    const entry = deps.blackboard.get(key);
    parts.push(
      entry
        ? `Blackboard ${key} (${entry.status}): ${clip(stringify(entry.value))}`
        : `Blackboard key ${key} does not exist.`,
    );
  }
  return parts.length > 0
    ? parts.join("\n")
    : `Cited source only: ${evidence.source}. No supporting text.`;
}

/** Jev critic pre-check: one Noul per claim, unsupported below the threshold become blocker findings. */
async function precheck(
  draft: Draft,
  deps: CriticDeps,
): Promise<{ findings: Finding[]; scores: Record<string, number> }> {
  const claims = draft.evidence.flatMap((evidence, index) =>
    evidence.claim
      ? [
          {
            id: `claim_${index}`,
            claim: evidence.claim,
            evidence: resolveEvidence(evidence, deps),
            source: evidence.source,
          },
        ]
      : [],
  );
  if (claims.length === 0) {
    return {
      scores: {},
      findings:
        draft.status === "degraded"
          ? []
          : [
              {
                claim: "(entry)",
                problem: "The entry carries no evidence-linked claims.",
                severity: "blocker",
              },
            ],
    };
  }
  const scores = await deps.jev.precheckClaims(
    claims.map(({ id, claim, evidence }) => ({ id, claim, evidence })),
  );
  const threshold = deps.precheckThreshold ?? 0.5;
  const findings: Finding[] = [];
  for (const c of claims) {
    const p = scores[c.id] ?? 0;
    if (p < threshold) {
      findings.push({
        claim: c.claim,
        problem: `Jev pre-check: probability the cited evidence supports this claim is ${p.toFixed(2)}, below ${threshold}.`,
        severity: "blocker",
        evidenceRef: c.source,
      });
    }
  }
  return { findings, scores };
}

export interface ReviewRequest {
  subtask: Subtask;
  draft: Draft;
  producer: { role: "researcher" | "executor"; agentId: string };
  attempt: number;
}

/**
 * Critic role: Jev pre-check first, then the critic's own review with the pre-check in hand.
 * Rejects when either finds a blocker. Emits `critic.verdict`.
 */
export async function reviewDraft(
  deps: CriticDeps,
  request: ReviewRequest,
): Promise<CriticVerdict> {
  const { subtask, draft, attempt } = request;
  let pre: Awaited<ReturnType<typeof precheck>>;
  try {
    pre = await precheck(draft, deps);
  } catch (err) {
    // Jev down: the critic's own review still runs; the gap is recorded, not hidden.
    pre = {
      scores: {},
      findings: [
        {
          claim: "(pre-check)",
          problem: `Jev pre-check unavailable: ${err instanceof Error ? err.message : String(err)}`,
          severity: "info",
        },
      ],
    };
  }

  const { output } = await runRole(deps, {
    role: "critic",
    subtaskId: subtask.id,
    system: CRITIC_SYSTEM,
    task: [
      `Review the candidate for subtask ${subtask.id}: ${subtask.title}`,
      subtask.description,
      `Output key: "${subtask.output.key}". Attempt ${attempt}.`,
      `Produced by the ${request.producer.role} (${request.producer.agentId}).`,
    ].join("\n"),
    inputs: {
      candidate: {
        value: draft.value,
        evidence: draft.evidence,
        status: draft.status,
        degradedReason: draft.degradedReason,
      },
      jevPrecheck: { scores: pre.scores, findings: pre.findings },
    },
    tools: toolsForRole("critic"),
    resultSchema: jsonSchemaOf(CriticResult),
    defaultMaxTurns: 10,
  });
  const own = CriticResult.parse(output);

  const findings = [...pre.findings, ...own.findings];
  const rejected = own.verdict === "rejected" || findings.some((f) => f.severity === "blocker");
  const verdict: CriticVerdict = { verdict: rejected ? "rejected" : "accepted", findings };
  deps.emit?.({
    kind: "critic.verdict",
    subtaskId: subtask.id,
    agentId: deps.agent.agentId,
    verdict: verdict.verdict,
    attempt,
    findings,
  });
  return verdict;
}
