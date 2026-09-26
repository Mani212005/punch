import { z } from "zod";
import { Reachability } from "@punch/shared";
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
 * Reachability role (plan.md 1, 8.1): the core differentiator. Decides exists vs exposed vs
 * exploitable for each vulnerability from the dependency graph, imports, call sites of the
 * affected symbols, entrypoints and routes, and test mapping.
 */
export const ReachabilityAssessmentSchema = z.object({
  dependency: z.string(),
  version: z.string(),
  advisoryIds: z.array(z.string()).min(1),
  reachability: Reachability,
});
export type ReachabilityAssessment = z.infer<typeof ReachabilityAssessmentSchema>;

export const ReachabilityResultSchema = z.object({
  assessments: z.array(ReachabilityAssessmentSchema).min(1),
});
export type ReachabilityResult = z.infer<typeof ReachabilityResultSchema>;

export const REACHABILITY_RESULT_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaOf(ReachabilityResultSchema);

export const REACHABILITY_SYSTEM = `You are the reachability agent in a security investigation. You decide whether each vulnerability's affected code can actually run in this repository. You gather facts with the provided tools and never state a fact you did not read from a tool result.

Rules:
- For each vulnerability: confirm the package is installed (dependency inventory / import graph), find imports of it (analyze_import_graph), search call sites of the affected symbols from the advisory (find_call_sites), and check entrypoints and routes (find_entrypoints_and_routes) plus test mapping (map_tests_for_module).
- Report the three levels separately: exists (the vulnerable dependency is present), exposed (the affected functionality can be reached from externally driven code: routes, entrypoints, exported API), exploitable (the vulnerable path is actually exercised in this repository).
- Verdict REACHABLE requires positive evidence of use. Verdict NOT_REACHABLE requires evidence of absence: a completed static search or import-graph result recorded as evidence that found no import and no call site. If the analysis could not run (truncated results, timeout, unparseable files), the verdict is UNKNOWN, never NOT_REACHABLE.
- Advisories without symbol data yield UNKNOWN for exploitability with the reason recorded.
- Every claim in your result must be listed in "evidence" with: "claim" (the statement, one fact per item), "source" (tool name or URL), "toolCallId" (the id of the tool call that produced it), and "quote" (the exact text from the tool result that supports it).
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

/** Guards the verdict rules in code: absence of evidence is never evidence of absence. */
export function assertReachabilityVerdicts(value: ReachabilityResult): void {
  for (const a of value.assessments) {
    const r = a.reachability;
    // A verdict needs its levels to agree with it: REACHABLE must have something to stand on
    // (the vulnerability exists), while NOT_REACHABLE must not claim anything is exposed or
    // exploited. exists=yes with NOT_REACHABLE is the normal "declared but never imported" case.
    if (r.verdict === "REACHABLE" && r.exists === "no") {
      throw new Error(
        `${a.dependency}: verdict REACHABLE contradicts exists=no; a reachable vulnerability must exist in the repository`,
      );
    }
    if (r.verdict === "NOT_REACHABLE" && (r.exposed === "yes" || r.exploitable === "yes")) {
      throw new Error(
        `${a.dependency}: verdict NOT_REACHABLE contradicts an exposed/exploitable level; re-examine the evidence`,
      );
    }
  }
}

function requireCitedEvidence(draft: Draft, ledger: ToolLedger): void {
  if (!draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError("reachability", "malformed", "result carries no evidence-linked claims");
  }
  for (const e of draft.evidence) {
    if (!e.claim) continue;
    // Every conclusion must cite recorded evidence: the tool call must exist in the trace.
    if (!e.toolCallId || !ledger.toolCall(e.toolCallId)) {
      throw new RoleRunError(
        "reachability",
        "malformed",
        `claim "${e.claim}" cites no recorded tool call; NOT_REACHABLE needs a completed search, never an assumption`,
      );
    }
  }
}

/** Reachability role: runs the subtask with the E1 static-analysis tools, returns a draft. */
export async function runReachability(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const { output } = await runRole(deps, {
    role: "reachability",
    subtaskId: subtask.id,
    system: REACHABILITY_SYSTEM,
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
    tools: toolsForRole("reachability"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 20,
  });
  const draft = draftFromEnvelope("reachability", output);
  if (draft.status === "ok") {
    const parsed = ReachabilityResultSchema.safeParse(draft.value);
    if (!parsed.success) {
      throw new RoleRunError("reachability", "malformed", parsed.error.message);
    }
    assertReachabilityVerdicts(parsed.data);
    requireCitedEvidence(draft, deps.ledger);
  }
  return draft;
}
