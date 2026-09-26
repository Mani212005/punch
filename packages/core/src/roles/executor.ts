import type { BlackboardEntry } from "@punch/shared";
import {
  draftFromEnvelope,
  producerResultSchema,
  revisionText,
  runRole,
  toolsForRole,
} from "./common.js";
import type { Draft, ProducerInput, RoleDeps } from "./common.js";

/** Shape of the plan.md section 1 output; the planner's default for the report subtask. */
export const REMEDIATION_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      description: "Vulnerable dependencies in priority order, most urgent first.",
      items: {
        type: "object",
        properties: {
          package: { type: "string" },
          currentVersion: { type: "string" },
          advisories: { type: "array", items: { type: "string" } },
          fixedVersion: { type: "string" },
          breakingChangeRisk: { type: "string", enum: ["low", "medium", "high", "unknown"] },
          recommendedAction: { type: "string" },
          priority: { type: "integer", minimum: 1 },
        },
        required: ["package", "recommendedAction", "priority"],
      },
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
      description: "Everything that could not be determined, including degraded inputs.",
    },
  },
  required: ["summary", "items", "unknowns"],
};

export const EXECUTOR_SYSTEM = `You are the executor in a dependency security triage run. You turn the blackboard into a prioritized remediation report: vulnerable dependencies, fixed versions, breaking-change risk of each upgrade, recommended action.

Rules:
- Read only what the blackboard holds (read_blackboard, list_blackboard). Add no fact that is not there.
- Inputs marked degraded are unknown, not fine. List them in "unknowns"; never present missing data as "no vulnerabilities" or "low risk".
- Every claim in your result must be listed in "evidence" with "claim" and "source" set to "blackboard:<key>" for the entry it came from.
- Call github_create_issue only when the subtask explicitly asks you to file an issue. It is irreversible and pauses for human approval; if it is denied, say so in "unknowns" and do not retry.
- Submit exactly once with write_result.`;

function degradedKeys(inputs: Record<string, BlackboardEntry>): string[] {
  return Object.values(inputs)
    .filter((e) => e.status === "degraded")
    .map((e) => e.key);
}

/** Executor role: writes the report; degraded inputs are always surfaced as unknown. */
export async function runExecutor(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const degraded = degradedKeys(input.inputs);
  const { output } = await runRole(deps, {
    role: "executor",
    subtaskId: subtask.id,
    system: EXECUTOR_SYSTEM,
    task: [
      input.brief ? `Run brief: ${input.brief}` : "",
      `Subtask ${subtask.id}: ${subtask.title}`,
      subtask.description,
      `Produce blackboard key "${subtask.output.key}".`,
      degraded.length > 0 ? `DEGRADED INPUTS (report as unknown): ${degraded.join(", ")}` : "",
      revisionText(input.revision),
    ]
      .filter(Boolean)
      .join("\n"),
    inputs: input.inputs,
    tools: toolsForRole("executor"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 12,
  });
  const draft = draftFromEnvelope("executor", output);
  return degraded.length > 0 ? surfaceDegraded(draft, degraded) : draft;
}

/** Guarantees the report lists each degraded input as unknown and the entry is marked degraded. */
function surfaceDegraded(draft: Draft, keys: string[]): Draft {
  let value = draft.value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["unknowns"])) {
      const unknowns = record["unknowns"].map(String);
      const missing = keys.filter((key) => !unknowns.some((line) => line.includes(key)));
      value = {
        ...record,
        unknowns: [
          ...unknowns,
          ...missing.map((key) => `${key}: input was degraded, so this part is unknown`),
        ],
      };
    }
  }
  return {
    ...draft,
    value,
    status: "degraded",
    degradedReason: draft.degradedReason ?? `report built on degraded inputs: ${keys.join(", ")}`,
  };
}
