import { z } from "zod";
import {
  CRITIC_CHALLENGE_IDS,
  type CriticChallengeId,
  CriticChallengeResult,
  Finding,
  NewTaskRequest,
  type Evidence,
  type SlotRole,
  type Subtask,
} from "@punch/shared";
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
  /** Whether to emit claim.verified / claim.refuted trace events. Default false unless enabled. */
  emitClaimEvents?: boolean;
}

export type CriticVerdict =
  | {
      decision: "ACCEPTED";
      verdict: "accepted";
      findingId: string;
      challenges: CriticChallengeResult[];
      findings: Finding[];
    }
  | {
      decision: "REJECTED";
      verdict: "rejected";
      findingId: string;
      challenges: CriticChallengeResult[];
      findings: Finding[];
      reason: string;
      missingEvidence: string[];
      newTask: NewTaskRequest;
    };

export function acceptedVerdict(
  findingId: string,
  findings: Finding[] = [],
  challenges?: CriticChallengeResult[],
): CriticVerdict {
  return {
    decision: "ACCEPTED",
    verdict: "accepted",
    findingId,
    challenges:
      challenges ??
      CRITIC_CHALLENGE_IDS.map((id) => ({
        challenge: id,
        outcome: "survived",
        reasoning: "No contradicting evidence found; challenge survived.",
        evidenceIds: [],
      })),
    findings,
  };
}

export const CRITIC_SYSTEM = `You are the adversarial critic in a security investigation. Your job is not merely checking formatting; your job is to try to prove the investigation wrong.

For every finding and candidate blackboard entry, you must evaluate all ten adversarial challenges (CRITIC_CHALLENGE_IDS):
1. vulnerability_applies: Does the vulnerability actually apply to this repository and dependency?
2. package_present: Is the vulnerable package actually present in the repository dependencies / manifest?
3. functionality_used: Is the affected functionality / API actually imported or used in the codebase?
4. code_reachable: Is the affected code reachable from entry points, routes, or exposed APIs?
5. patched_version_real: Is the proposed patched version real and available in package registry metadata?
6. upgrade_compatible: Is the proposed upgrade compatible, without unhandled breaking changes?
7. sources_contradict: Did another independent source (OSV, GitHub Advisory, release notes) contradict the finding?
8. evidence_current: Is the cited evidence current and fresh, not stale or superseded?
9. safer_mitigation: Is there a safer mitigation available than the proposed action?
10. unsupported_assumption: Did the investigator make an unsupported assumption, unbacked claim, or cite nonexistent evidence?

Rules:
- Verify every claim against its cited evidence using get_tool_result to read recorded tool call outputs and read_blackboard / list_blackboard for blackboard entries. You have read access only.
- Reject any claim citing a fabricated version, non-existent advisory, missing file, unverified function, or unrecorded tool call.
- The Jev pre-check results are a signal to investigate: evaluate and cross-check each score with your own reading of the evidence.
- On rejection: return decision "REJECTED" (verdict "rejected"), explain the reason, list the missing evidence, and specify the targeted newTask (with role, title, description, and claimIds) for the planner to replan.
- Submit with write_result: decision ("ACCEPTED" or "REJECTED"), challenges (outcome "survived", "failed", or "not_applicable", with reasoning and evidenceIds for each of the 10 challenges), findings, reason, missingEvidence, and newTask if rejected.`;

const CriticResultSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED"]).optional(),
  verdict: z.enum(["accepted", "rejected"]).optional(),
  findingId: z.string().optional(),
  challenges: z.array(CriticChallengeResult).optional(),
  findings: z.array(Finding).default([]),
  reason: z.string().optional(),
  missingEvidence: z.array(z.string()).optional(),
  newTask: NewTaskRequest.optional(),
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

export function defaultTaskForChallenge(
  challenge: CriticChallengeId,
  reason: string,
  claimIds: string[] = [],
): NewTaskRequest {
  switch (challenge) {
    case "code_reachable":
    case "functionality_used":
      return {
        role: "reachability",
        title: "Reachability analysis",
        description: reason || "Perform call-site analysis and import graph search for affected symbols",
        claimIds,
      };
    case "package_present":
      return {
        role: "inventory",
        title: "Inventory check",
        description: reason || "Verify package presence in repository manifests and lockfiles",
        claimIds,
      };
    case "patched_version_real":
    case "vulnerability_applies":
    case "sources_contradict":
      return {
        role: "researcher",
        title: "Vulnerability research",
        description: reason || "Re-query advisories and verify registry release versions",
        claimIds,
      };
    case "upgrade_compatible":
    case "safer_mitigation":
      return {
        role: "impact",
        title: "Upgrade impact analysis",
        description: reason || "Assess breaking changes, removed APIs, and upgrade impact",
        claimIds,
      };
    case "evidence_current":
    case "unsupported_assumption":
    default:
      return {
        role: "researcher",
        title: "Evidence investigation",
        description: reason || "Gather fresh supporting evidence for unverified claims",
        claimIds,
      };
  }
}

/** Maps a claim or problem text to the most relevant challenge ID. */
export function classifyChallengeForProblem(
  claimText: string,
  problemText: string,
): CriticChallengeId {
  const combined = `${claimText} ${problemText}`.toLowerCase();
  if (combined.includes("reachable") || combined.includes("call-site") || combined.includes("entrypoint")) {
    return "code_reachable";
  }
  if (combined.includes("function") || combined.includes("import") || combined.includes("used")) {
    return "functionality_used";
  }
  if (combined.includes("version") || combined.includes("patched") || combined.includes("registry")) {
    return "patched_version_real";
  }
  if (combined.includes("package") || combined.includes("install") || combined.includes("present") || combined.includes("manifest")) {
    return "package_present";
  }
  if (combined.includes("contradict") || combined.includes("second source") || combined.includes("advisory")) {
    return "sources_contradict";
  }
  if (combined.includes("stale") || combined.includes("current") || combined.includes("superseded")) {
    return "evidence_current";
  }
  if (combined.includes("upgrade") || combined.includes("compat") || combined.includes("breaking")) {
    return "upgrade_compatible";
  }
  if (combined.includes("mitigat")) {
    return "safer_mitigation";
  }
  if (combined.includes("vulnerab") || combined.includes("applies")) {
    return "vulnerability_applies";
  }
  return "unsupported_assumption";
}

interface PrecheckResult {
  findings: Finding[];
  scores: Record<string, number>;
  failedChallenges: Map<CriticChallengeId, { reason: string; claimId: string }>;
}

/** Jev critic pre-check: one Noul per claim, unsupported below the threshold become blocker findings. */
async function precheck(draft: Draft, deps: CriticDeps): Promise<PrecheckResult> {
  const claims = draft.evidence.flatMap((evidence, index) =>
    evidence.claim
      ? [
          {
            id: `claim_${index}`,
            claim: evidence.claim,
            evidence: resolveEvidence(evidence, deps),
            source: evidence.source,
            toolCallId: evidence.toolCallId,
          },
        ]
      : [],
  );

  const failedChallenges = new Map<CriticChallengeId, { reason: string; claimId: string }>();

  if (claims.length === 0) {
    if (draft.status !== "degraded") {
      const problem = "The entry carries no evidence-linked claims.";
      failedChallenges.set("unsupported_assumption", { reason: problem, claimId: "claim_none" });
      return {
        scores: {},
        findings: [
          {
            claim: "(entry)",
            problem,
            severity: "blocker",
          },
        ],
        failedChallenges,
      };
    }
    return {
      scores: {},
      findings: [],
      failedChallenges,
    };
  }

  const scores = await deps.jev.precheckClaims(
    claims.map(({ id, claim, evidence }) => ({ id, claim, evidence })),
  );
  const threshold = deps.precheckThreshold ?? 0.5;
  const findings: Finding[] = [];

  for (const c of claims) {
    const p = scores[c.id] ?? 0;
    const toolCallMissing = c.toolCallId && !deps.ledger.toolCall(c.toolCallId);
    if (p < threshold || toolCallMissing) {
      const reason = toolCallMissing
        ? `Claim cites tool call ${c.toolCallId} which does not exist in the trace.`
        : `Jev pre-check: probability the cited evidence supports this claim is ${p.toFixed(2)}, below ${threshold}.`;

      findings.push({
        claim: c.claim,
        problem: reason,
        severity: "blocker",
        evidenceRef: c.source,
      });

      if (deps.emitClaimEvents) {
        deps.emit?.({
          kind: "claim.refuted",
          claimId: c.id,
          verifier: { role: "critic", agentId: deps.agent.agentId },
          rationale: reason,
        });
      }

      const challengeId = classifyChallengeForProblem(c.claim, reason);
      if (!failedChallenges.has(challengeId)) {
        failedChallenges.set(challengeId, { reason, claimId: c.id });
      }
    } else {
      if (deps.emitClaimEvents) {
        deps.emit?.({
          kind: "claim.verified",
          claimId: c.id,
          verifier: { role: "critic", agentId: deps.agent.agentId },
          rationale: "Claim supported by cited evidence.",
        });
      }
    }
  }

  return { findings, scores, failedChallenges };
}

export interface ReviewRequest {
  subtask: Subtask;
  draft: Draft;
  producer: { role: SlotRole; agentId: string };
  attempt: number;
  findingId?: string;
  emitClaimEvents?: boolean;
}

/**
 * Adversarial Critic role: evaluates the ten challenges (CRITIC_CHALLENGE_IDS),
 * performs Jev pre-check and hallucination detection, verifies claims against trace/blackboard,
 * and emits critic.verdict.
 */
export async function reviewDraft(
  deps: CriticDeps,
  request: ReviewRequest,
): Promise<CriticVerdict> {
  const { subtask, draft, attempt } = request;
  const findingId = request.findingId ?? subtask.id;

  let pre: PrecheckResult;
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
      failedChallenges: new Map(),
    };
  }

  let output: unknown;
  try {
    const runRes = await runRole(deps, {
      role: "critic",
      subtaskId: subtask.id,
      system: CRITIC_SYSTEM,
      task: [
        `Adversarially review the candidate for subtask ${subtask.id}: ${subtask.title}`,
        subtask.description,
        `Output key: "${subtask.output.key}". Attempt ${attempt}.`,
        `Produced by the ${request.producer.role} (${request.producer.agentId}).`,
        "Run each of the ten adversarial challenges (CRITIC_CHALLENGE_IDS).",
        "If any claim is unsupported, contradicted, or hallucinated, reject with reason, missingEvidence, and newTask.",
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
      resultSchema: jsonSchemaOf(CriticResultSchema),
      defaultMaxTurns: 10,
    });
    output = runRes.output;
  } catch (err) {
    // If the model invocation fails with a malformed output or error, propagate unless precheck had blockers
    if (pre.findings.some((f) => f.severity === "blocker")) {
      output = {
        decision: "REJECTED",
        verdict: "rejected",
        findings: pre.findings,
      };
    } else {
      throw err;
    }
  }

  const own = CriticResultSchema.parse(output);

  // Combine findings
  const findings: Finding[] = [...pre.findings, ...own.findings];

  // Build the 10 challenge results
  const challengeMap = new Map<CriticChallengeId, CriticChallengeResult>();
  if (own.challenges) {
    for (const c of own.challenges) {
      challengeMap.set(c.challenge, c);
    }
  }

  // Overlay pre-check challenge failures
  for (const [challengeId, { reason }] of pre.failedChallenges.entries()) {
    challengeMap.set(challengeId, {
      challenge: challengeId,
      outcome: "failed",
      reasoning: reason,
      evidenceIds: [],
    });
  }

  // Also check if any model finding has severity blocker or rejected verdict
  for (const f of own.findings) {
    if (f.severity === "blocker") {
      const challengeId = classifyChallengeForProblem(f.claim, f.problem);
      if (!challengeMap.has(challengeId) || challengeMap.get(challengeId)?.outcome !== "failed") {
        challengeMap.set(challengeId, {
          challenge: challengeId,
          outcome: "failed",
          reasoning: f.problem,
          evidenceIds: f.evidenceRef ? [f.evidenceRef] : [],
        });
      }
    }
  }

  // Fill in any of the 10 challenges that were omitted
  const allChallenges: CriticChallengeResult[] = CRITIC_CHALLENGE_IDS.map((id) => {
    const existing = challengeMap.get(id);
    if (existing) return existing;
    return {
      challenge: id,
      outcome: "survived",
      reasoning: "No contradicting evidence found; challenge survived.",
      evidenceIds: [],
    };
  });

  const anyChallengeFailed = allChallenges.some((c) => c.outcome === "failed");
  const anyBlocker = findings.some((f) => f.severity === "blocker");
  const modelRejected = own.decision === "REJECTED" || own.verdict === "rejected";
  const rejected = anyChallengeFailed || anyBlocker || modelRejected;

  let verdict: CriticVerdict;

  if (rejected) {
    const firstFailed = allChallenges.find((c) => c.outcome === "failed")?.challenge ?? "unsupported_assumption";
    const blockerReason = findings.find((f) => f.severity === "blocker")?.problem;
    const reason =
      own.reason ||
      blockerReason ||
      allChallenges.find((c) => c.outcome === "failed")?.reasoning ||
      "Investigation rejected due to unverified or contradicted claims.";

    const missingEvidence =
      own.missingEvidence && own.missingEvidence.length > 0
        ? own.missingEvidence
        : findings.filter((f) => f.severity === "blocker").map((f) => f.problem);

    const explicitRequestedTask = findings.find((f) => f.requestedTask)?.requestedTask;
    const explicitNewTask: NewTaskRequest | undefined =
      own.newTask ||
      (explicitRequestedTask
        ? {
            role: explicitRequestedTask.roleHint ?? defaultTaskForChallenge(firstFailed, reason).role,
            title: explicitRequestedTask.title,
            description: explicitRequestedTask.description,
            claimIds: explicitRequestedTask.claimIds ?? [],
          }
        : undefined);

    if (explicitNewTask) {
      for (const f of findings) {
        if (f.severity === "blocker" && !f.requestedTask) {
          f.requestedTask = {
            title: explicitNewTask.title,
            description: explicitNewTask.description,
            roleHint: explicitNewTask.role,
            claimIds: explicitNewTask.claimIds,
          };
        }
      }
    }

    const newTask: NewTaskRequest =
      explicitNewTask ?? defaultTaskForChallenge(firstFailed, reason);

    verdict = {
      decision: "REJECTED",
      verdict: "rejected",
      findingId,
      challenges: allChallenges,
      findings,
      reason,
      missingEvidence: missingEvidence.length > 0 ? missingEvidence : [reason],
      newTask,
    };
  } else {
    verdict = {
      decision: "ACCEPTED",
      verdict: "accepted",
      findingId,
      challenges: allChallenges,
      findings,
    };
  }

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
