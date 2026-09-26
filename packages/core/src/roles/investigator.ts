import { z } from "zod";
import type {
  RecommendedAction} from "@punch/shared";
import {
  InvestigationFinding,
  type ImpactLevel,
  type ReachabilityVerdict,
  type SandboxVerdict,
  type Severity,
} from "@punch/shared";
import {
  RoleRunError,
  draftFromEnvelope,
  jsonSchemaOf,
  producerResultSchema,
  revisionText,
  runRole,
  toolsForRole,
} from "./common.js";
import type { Draft, ProducerInput, RoleDeps } from "./common.js";

/**
 * Security investigator role (plan.md 1, 8.x): synthesizes the inventory, vulnerability
 * research, reachability and upgrade impact streams into one finding per vulnerability with
 * claims tied to evidence and a recommended action. Reads the blackboard; no external tools,
 * so it reconciles evidence instead of gathering more.
 */
export const InvestigatorResultSchema = z.object({
  findings: z.array(InvestigationFinding).min(1),
  /** Candidate remediations for the E5 sandbox: upgrades the validator should simulate. */
  remediations: z
    .array(
      z.object({
        findingId: z.string(),
        dependency: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .default([]),
});
export type InvestigatorResult = z.infer<typeof InvestigatorResultSchema>;

export const INVESTIGATOR_RESULT_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaOf(InvestigatorResultSchema);

/**
 * Recommendation rules (plan.md 8): unreachable and low severity can be NO_ACTION or MONITOR
 * with the evidence stated; reachable plus validated sandbox PASS is UPGRADE; sandbox FAIL or
 * NOT_RUN, HIGH impact, or UNKNOWN reachability on a high severity is HUMAN_REVIEW.
 */
export function recommendAction(input: {
  severity: Severity;
  reachability: ReachabilityVerdict;
  impact: ImpactLevel | null;
  sandbox: SandboxVerdict | null;
}): RecommendedAction {
  if (input.sandbox === "FAIL" || input.sandbox === "NOT_RUN") return "HUMAN_REVIEW";
  if (input.impact === "HIGH") return "HUMAN_REVIEW";
  if (input.reachability === "UNKNOWN" && (input.severity === "HIGH" || input.severity === "CRITICAL")) {
    return "HUMAN_REVIEW";
  }
  if (input.reachability === "REACHABLE" && input.sandbox === "PASS") return "UPGRADE";
  if (input.reachability === "REACHABLE") return "HUMAN_REVIEW";
  if (
    input.reachability === "NOT_REACHABLE" &&
    (input.severity === "LOW" || input.severity === "UNKNOWN")
  ) {
    return "MONITOR";
  }
  if (input.reachability === "NOT_REACHABLE") return "NO_ACTION";
  return "HUMAN_REVIEW";
}

/** The investigator's findings must follow the recommendation rules above. */
export function assertRecommendationRules(value: InvestigatorResult): void {
  for (const f of value.findings) {
    const expected = recommendAction({
      severity: f.severity,
      reachability: f.reachability.verdict,
      impact: f.upgradeImpact?.level ?? null,
      sandbox: f.sandbox?.verdict ?? null,
    });
    if (f.recommendedAction !== expected) {
      throw new Error(
        `finding ${f.id}: recommended action ${f.recommendedAction} breaks the rules for ${f.reachability.verdict}/${f.severity} (expected ${expected}); state the evidence or follow the rule`,
      );
    }
  }
}

export const INVESTIGATOR_SYSTEM = `You are the security investigator in a dependency vulnerability investigation. You synthesize the inventory, vulnerability research, reachability and upgrade impact evidence into one finding per vulnerability with a recommended action. You read only what the blackboard holds (read_blackboard, list_blackboard); you gather no new external facts.

Rules:
- Reconcile the four evidence streams into one finding per vulnerability: dependency, version, advisory ids, severity, reachability, upgrade from and to, upgrade impact, recommended action and reasoning. Where inputs contradict, say so in the reasoning and choose the conclusion the stronger evidence supports; never hide a contradiction.
- Reaching a conclusion the evidence does not support is the critic's first challenge: every claim in your result must be listed in "evidence" with "claim" and "source" set to "blackboard:<key>" for the entry it came from, plus the toolCallId when the entry's own evidence names one.
- Recommendation rules: unreachable with low severity is NO_ACTION or MONITOR with the evidence stated; reachable plus validated sandbox PASS is UPGRADE; sandbox FAIL or NOT_RUN, HIGH impact, or UNKNOWN reachability on a high severity is HUMAN_REVIEW. A missing sandbox validation is never a PASS.
- Candidate remediations ("remediations"): one entry per finding you would upgrade, so the sandbox can simulate it.
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

function requireCitedEvidence(draft: Draft): void {
  if (!draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError(
      "investigator",
      "malformed",
      "result carries no evidence-linked claims",
    );
  }
  const uncited = draft.evidence.filter((e) => e.claim && !e.source.startsWith("blackboard:"));
  if (uncited.length > 0) {
    throw new RoleRunError(
      "investigator",
      "malformed",
      "every claim must cite the blackboard entry it came from (source blackboard:<key>)",
    );
  }
}

/** Security investigator role: reads the blackboard, synthesizes findings, returns a draft. */
export async function runInvestigator(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const { output } = await runRole(deps, {
    role: "investigator",
    subtaskId: subtask.id,
    system: INVESTIGATOR_SYSTEM,
    task: [
      input.brief ? `Run brief: ${input.brief}` : "",
      `Subtask ${subtask.id}: ${subtask.title}`,
      subtask.description,
      `Produce blackboard key "${subtask.output.key}".`,
      revisionText(input.revision),
    ]
      .filter(Boolean)
      .join("\n"),
    inputs: input.inputs,
    tools: toolsForRole("investigator"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 12,
  });
  const draft = draftFromEnvelope("investigator", output);
  if (draft.status === "ok") {
    const parsed = InvestigatorResultSchema.safeParse(draft.value);
    if (!parsed.success) {
      throw new RoleRunError("investigator", "malformed", parsed.error.message);
    }
    assertRecommendationRules(parsed.data);
    requireCitedEvidence(draft);
  }
  return draft;
}
