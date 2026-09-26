import { existsSync } from "node:fs";
import { z } from "zod";
import { SandboxValidation, type BlackboardEntry } from "@punch/shared";
import { validateUpgrade } from "../sandbox/validate.js";
import type { Draft } from "./common.js";

/**
 * Code-driven validation step (plan.md 1, 8.4). The validator is deliberately not an LLM slot:
 * it runs the real install/build/test commands through the merged E5 validator and authors
 * `sandbox_run` evidence and `sandbox` claims. The trace names it as role `validator`.
 */
export const ValidationStepResultSchema = z.object({
  validations: z.array(
    z.object({
      findingId: z.string(),
      dependency: z.string(),
      from: z.string(),
      to: z.string().nullable(),
      /** Null when there was nothing to validate (no patched version proposed). */
      validation: SandboxValidation.nullable(),
    }),
  ),
});
export type ValidationStepResult = z.infer<typeof ValidationStepResultSchema>;

export interface ValidationStepInput {
  subtaskId: string;
  inputs: Record<string, BlackboardEntry>;
  /** Repository checkout for the validator; resolved from the inventory entry when absent. */
  repoDir?: string;
  /** `auto` refuses without Docker (NOT_RUN, nothing executes); `host` is the explicit opt-in. */
  mode?: "auto" | "host";
  signal?: AbortSignal;
  now?: () => number;
  emit?: (event: Record<string, unknown>) => void;
  run?: typeof validateUpgrade;
}

interface Remediation {
  findingId: string;
  dependency: string;
  from: string;
  to: string;
}

/** Candidate remediations come from the investigator; each names a concrete upgrade to simulate. */
function readRemediations(inputs: Record<string, BlackboardEntry>): Remediation[] {
  const found: Remediation[] = [];
  for (const entry of Object.values(inputs)) {
    const value = entry.value as { remediations?: unknown };
    if (!value || typeof value !== "object" || !Array.isArray(value.remediations)) continue;
    for (const r of value.remediations) {
      const parsed = z
        .object({ findingId: z.string(), dependency: z.string(), from: z.string(), to: z.string() })
        .safeParse(r);
      if (parsed.success) found.push(parsed.data);
    }
  }
  // One validation per finding; the investigator lists each finding once.
  return [...new Map(found.map((r) => [r.findingId, r])).values()];
}

/** The repository checkout is whatever the inventory agent fetched; otherwise there is none. */
function resolveRepoDir(
  inputs: Record<string, BlackboardEntry>,
  explicit?: string,
): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  for (const entry of Object.values(inputs)) {
    const value = entry.value as { workdir?: unknown; inventory?: { workdir?: unknown } };
    const candidate =
      (typeof value?.workdir === "string" && value.workdir) ||
      (typeof value?.inventory === "object" &&
        value.inventory !== null &&
        typeof (value.inventory as { workdir?: unknown }).workdir === "string" &&
        (value.inventory as { workdir: string }).workdir) ||
      undefined;
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Runs the E5 validator for every candidate remediation and returns the step draft.
 * Without a checkout the step still records NOT_RUN validations, so the report can say
 * "human review required" instead of guessing.
 */
export async function runValidationStep(input: ValidationStepInput): Promise<Draft> {
  const run = input.run ?? validateUpgrade;
  const now = input.now ?? Date.now;
  const emit = input.emit ?? (() => {});
  const repoDir = resolveRepoDir(input.inputs, input.repoDir);
  const remediations = readRemediations(input.inputs);
  const trace = { write: (e: never) => emit(e as Record<string, unknown>) };

  const validations: ValidationStepResult["validations"] = [];
  const evidence: Draft["evidence"] = [];
  for (const r of remediations) {
    if (!repoDir) {
      const validation: SandboxValidation = {
        isolation: "none",
        note: "not run (no repository checkout available to the validator)",
        baseline: null,
        candidate: null,
        newFailures: [],
        fixedFailures: [],
        changedFiles: [],
        verdict: "NOT_RUN",
        evidenceIds: [],
      };
      emit({
        kind: "sandbox.started",
        findingId: r.findingId,
        dependency: r.dependency,
        from: r.from,
        to: r.to,
        isolation: "none",
      });
      emit({ kind: "sandbox.finished", findingId: r.findingId, validation });
      validations.push({ ...r, validation });
      continue;
    }
    const { validation, evidence: runEvidence } = await run({
      findingId: r.findingId,
      repoDir,
      dependency: r.dependency,
      from: r.from,
      to: r.to,
      ...(input.mode ? { mode: input.mode } : {}),
      trace,
      ...(input.signal ? { signal: input.signal } : {}),
      now,
    });
    validations.push({ ...r, validation });
    for (const record of runEvidence) {
      // The validator's sandbox_run records are already traced; cite them as claims here.
      evidence.push({
        claim: `sandbox validation of ${r.dependency} ${r.from} -> ${r.to}: ${validation.verdict}`,
        source: `sandbox:${r.findingId}`,
        quote: record.excerpt,
      });
    }
  }

  const value: ValidationStepResult = { validations };
  const parsed = ValidationStepResultSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`validator produced an invalid result: ${parsed.error.message}`);
  return {
    value: parsed.data,
    evidence,
    status: "ok",
  };
}
