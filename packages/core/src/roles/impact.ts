import { z } from "zod";
import { UpgradeImpact } from "@punch/shared";
import {
  RoleRunError,
  draftFromEnvelope,
  jsonSchemaOf,
  producerResultSchema,
  revisionText,
  runRole,
  toolsForRole,
} from "./common.js";
import type { Draft, ProducerInput, RoleDeps, ToolLedger } from "./common.js";

/**
 * Upgrade impact role (plan.md 1, 8.2): separates "is there a fix" from "is the fix safe",
 * using release notes and real repository usage instead of a guessed percentage.
 */
export const ImpactAssessmentSchema = z.object({
  dependency: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  /** Major, minor, patch, or unknown when the versions cannot be compared. */
  semverChange: z.enum(["major", "minor", "patch", "unknown"]),
  /** Release notes or changelog excerpt the agent actually read, or null when none exists. */
  releaseNotes: z.string().nullable(),
  /** Removed or deprecated APIs that the repository actually uses. */
  removedApisInUse: z.array(z.string()).default([]),
  impact: UpgradeImpact,
});
export type ImpactAssessment = z.infer<typeof ImpactAssessmentSchema>;

export const ImpactResultSchema = z.object({
  impacts: z.array(ImpactAssessmentSchema).min(1),
});
export type ImpactResult = z.infer<typeof ImpactResultSchema>;

export const IMPACT_RESULT_JSON_SCHEMA: Record<string, unknown> = jsonSchemaOf(ImpactResultSchema);

/** Numeric safety percentages without a methodology are forbidden (plan.md 8.2). */
const INVENTED_PERCENTAGE = /\b\d{1,3}%\s*(safe|safer|safety|compatible|compatibility|success|successful)\b/i;

export function assertNoInventedPercentages(value: unknown): void {
  const text = JSON.stringify(value);
  const hit = INVENTED_PERCENTAGE.exec(text);
  if (hit) {
    throw new Error(
      `invented upgrade-safety percentage "${hit[0]}": report LOW / MEDIUM / HIGH with evidence, never a guessed number`,
    );
  }
}

export const IMPACT_SYSTEM = `You are the upgrade impact agent in a security investigation. You assess what an upgrade could break. You gather facts with the provided tools and never state a fact you did not read from a tool result.

Rules:
- For each candidate upgrade: compare current and patched versions (semver change), read release notes and changelogs (get_release_notes, github_get_releases, github_compare_commits), check removed or deprecated APIs against real repository usage (repo source tools), and check lockfile changes, dependency tree, tests and CI configuration.
- Report impact as LOW / MEDIUM / HIGH with detected risks and unknowns, each tied to claims. Numeric probabilities such as "87% safe" are forbidden: never invent a percentage.
- A missing changelog is an unknown, not a clean bill of health. Private registries you cannot read are unknowns.
- Every claim in your result must be listed in "evidence" with: "claim" (the statement, one fact per item), "source" (tool name or URL), "toolCallId" (the id of the tool call that produced it), and "quote" (the exact text from the tool result that supports it).
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

function requireCitedEvidence(draft: Draft, ledger: ToolLedger): void {
  if (!draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError("impact", "malformed", "result carries no evidence-linked claims");
  }
  for (const e of draft.evidence) {
    if (!e.claim) continue;
    // Every conclusion must cite recorded evidence: the tool call must exist in the trace.
    if (!e.toolCallId || !ledger.toolCall(e.toolCallId)) {
      throw new RoleRunError(
        "impact",
        "malformed",
        `claim "${e.claim}" cites no recorded tool call; impact levels need evidence, never assumption`,
      );
    }
  }
}

/** Upgrade impact role: runs the subtask with releases/registry/source tools, returns a draft. */
export async function runImpact(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const { output } = await runRole(deps, {
    role: "impact",
    subtaskId: subtask.id,
    system: IMPACT_SYSTEM,
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
    tools: toolsForRole("impact"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 20,
  });
  const draft = draftFromEnvelope("impact", output);
  if (draft.status === "ok") {
    const parsed = ImpactResultSchema.safeParse(draft.value);
    if (!parsed.success) {
      throw new RoleRunError("impact", "malformed", parsed.error.message);
    }
    assertNoInventedPercentages(draft.value);
    requireCitedEvidence(draft, deps.ledger);
  }
  return draft;
}
