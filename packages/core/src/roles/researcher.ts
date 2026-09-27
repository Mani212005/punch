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
import { z } from "zod";

/**
 * Vulnerability research result: one entry per dependency with advisories, severity,
 * affected symbols where advisories name them, the patched version, and the sources used.
 */
export const VulnerabilityResearchSchema = z.object({
  vulnerabilities: z.array(
    z.object({
      dependency: z.string(),
      version: z.string(),
      advisoryIds: z.array(z.string()).min(1),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]),
      affectedSymbols: z.array(z.string()).default([]),
      patchedVersion: z.string().nullable(),
      sources: z.array(z.string()).min(1),
    }),
  ),
});
export type VulnerabilityResearch = z.infer<typeof VulnerabilityResearchSchema>;

export const VULNERABILITY_RESEARCH_JSON_SCHEMA: Record<string, unknown> = jsonSchemaOf(
  VulnerabilityResearchSchema,
);

export const RESEARCHER_SYSTEM = `You are the vulnerability researcher in a security investigation. You query advisories per dependency, find patched versions, and read release notes. You gather facts with the provided tools and never state a fact you did not read from a tool result.

Rules:
- Use tools for every version, advisory, and release note. Do not answer from memory. Cross-check OSV against GitHub Advisory and the npm registry: claims backed by two independent sources survive the critic.
- Record affected functions and symbols wherever advisories name them, plus the patched version and the sources you used.
- Every claim in your result must be listed in "evidence" with: "claim" (the statement, one fact per item), "source" (tool name or URL), "toolCallId" (the id of the tool call that produced it), and "quote" (the exact text from the tool result that supports it).
- If a tool fails, empty results are not proof of safety. Report what you could not obtain in "degradedReason" and leave that field of the value unknown; never guess a version or an advisory.
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

/** Vulnerability research role: runs the subtask with the A3 tools and returns an evidence-linked draft. */
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
    defaultMaxTurns: 8,
  });
  const draft = draftFromEnvelope("researcher", output);
  if (draft.status === "ok" && !draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError("researcher", "malformed", "result carries no evidence-linked claims");
  }
  return draft;
}
