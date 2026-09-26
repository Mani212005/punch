import {
  RoleRunError,
  draftFromEnvelope,
  producerResultSchema,
  revisionText,
  runRole,
  toolsForRole,
} from "./common.js";
import type { Draft, ProducerInput, RoleDeps } from "./common.js";

export const RESEARCHER_SYSTEM = `You are the researcher in a dependency security triage run. You gather facts with the provided tools and never state a fact you did not read from a tool result.

Rules:
- Use tools for every version, advisory, and release note. Do not answer from memory.
- Every claim in your result must be listed in "evidence" with: "claim" (the statement, one fact per item), "source" (tool name or URL), "toolCallId" (the id of the tool call that produced it), and "quote" (the exact text from the tool result that supports it).
- If a tool fails, empty results are not proof of safety. Report what you could not obtain in "degradedReason" and leave that field of the value unknown; never guess a version or an advisory.
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

/** Researcher role: runs the subtask with the A3 tools and returns an evidence-linked draft. */
export async function runResearcher(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const { output } = await runRole(deps, {
    role: "researcher",
    subtaskId: subtask.id,
    system: RESEARCHER_SYSTEM,
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
    tools: toolsForRole("researcher"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 16,
  });
  const draft = draftFromEnvelope("researcher", output);
  if (draft.status === "ok" && !draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError("researcher", "malformed", "result carries no evidence-linked claims");
  }
  return draft;
}
