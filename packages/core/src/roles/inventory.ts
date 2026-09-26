import { z } from "zod";
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
import { DependencyInventorySchema } from "../tools/inventory.js";

/**
 * Inventory role (plan.md 1): lists the repository's dependencies from manifests and
 * lockfiles, so "package present" is evidence and not assumption for every later step.
 */
export const InventoryResultSchema = z.object({
  repository: z.string(),
  /** Per-run read-only workdir holding the fetched source, when the agent fetched it. */
  workdir: z.string().optional(),
  inventory: DependencyInventorySchema,
  /** Dependency graph edges the agent observed (importer -> imported package). */
  dependencyEdges: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
});
export type InventoryResult = z.infer<typeof InventoryResultSchema>;

export const INVENTORY_RESULT_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaOf(InventoryResultSchema);

export const INVENTORY_SYSTEM = `You are the inventory agent in a security investigation. You list the repository's dependencies from manifests, lockfiles and the dependency graph. You gather facts with the provided tools and never state a fact you did not read from a tool result.

Rules:
- Fetch the repository source first (fetch_repo_source), then read package.json and lockfiles (read_repo_file, github_get_contents) and parse them (parse_dependency_inventory). Record the workdir path in "workdir" so later steps analyze the same checkout.
- Every claim in your result must be listed in "evidence" with: "claim" (the statement, one fact per item), "source" (tool name or URL), "toolCallId" (the id of the tool call that produced it), and "quote" (the exact text from the tool result that supports it).
- If a manifest or lockfile is missing, say so in "degradedReason" and leave the missing part unknown; a missing lockfile is never proof of exact versions.
- Submit exactly once with write_result: "value" must satisfy the subtask's output schema.`;

function requireCitedEvidence(draft: Draft): void {
  if (!draft.evidence.some((e) => e.claim)) {
    throw new RoleRunError("inventory", "malformed", "result carries no evidence-linked claims");
  }
  const uncited = draft.evidence.filter((e) => e.claim && !e.toolCallId);
  if (uncited.length > 0) {
    throw new RoleRunError(
      "inventory",
      "malformed",
      "every claim must cite the recorded tool call that produced it (toolCallId)",
    );
  }
}

/** Inventory role: runs the subtask with repo source and inventory tools, returns a draft. */
export async function runInventory(deps: RoleDeps, input: ProducerInput): Promise<Draft> {
  const { subtask } = input;
  const { output } = await runRole(deps, {
    role: "inventory",
    subtaskId: subtask.id,
    system: INVENTORY_SYSTEM,
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
    tools: toolsForRole("inventory"),
    resultSchema: producerResultSchema(subtask),
    defaultMaxTurns: 16,
  });
  const draft = draftFromEnvelope("inventory", output);
  if (draft.status === "ok") requireCitedEvidence(draft);
  return draft;
}
