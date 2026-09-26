import type { Subtask } from "@punch/shared";
import { Plan, type BlackboardEntry } from "@punch/shared";
import { REMEDIATION_REPORT_SCHEMA } from "./roles/executor.js";
import { IMPACT_RESULT_JSON_SCHEMA } from "./roles/impact.js";
import { INVESTIGATOR_RESULT_JSON_SCHEMA } from "./roles/investigator.js";
import { INVENTORY_RESULT_JSON_SCHEMA } from "./roles/inventory.js";
import { REACHABILITY_RESULT_JSON_SCHEMA } from "./roles/reachability.js";
import { VULNERABILITY_RESEARCH_JSON_SCHEMA } from "./roles/researcher.js";
import { ValidationStepResultSchema } from "./roles/validator.js";
import {
  GENERIC_OBJECT_SCHEMA,
  RoleRunError,
  jsonSchemaOf,
  runRole,
  type RoleDeps,
} from "./roles/common.js";

export interface PlanRequest {
  brief: string;
  repoUrl?: string;
}

export interface ReplanRequest extends PlanRequest {
  plan: Plan;
  failedSubtaskId: string;
  reason: string;
  /** Blackboard state at the time of failure; keys here are available as inputs. */
  blackboard: Record<string, BlackboardEntry>;
}

/** The plan still broke a rule after the one correction round. */
export class PlanValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`planner produced an invalid plan: ${errors.join("; ")}`);
    this.name = "PlanValidationError";
  }
}

export interface ValidatePlanOptions {
  /** Keys that exist before the plan runs (blackboard state on a replan). */
  externalKeys?: Iterable<string>;
}

/** DAG rules: unique ids and keys, known dependencies, no cycle, every input produced upstream. */
export function validatePlan(plan: Plan, options: ValidatePlanOptions = {}): string[] {
  const errors: string[] = [];
  const external = new Set(options.externalKeys ?? []);
  const byId = new Map<string, Subtask>();
  const keyOwner = new Map<string, string>();
  for (const s of plan.subtasks) {
    if (byId.has(s.id)) errors.push(`duplicate subtask id "${s.id}"`);
    byId.set(s.id, s);
    const owner = keyOwner.get(s.output.key);
    if (owner !== undefined) {
      errors.push(`output key "${s.output.key}" is produced by both "${owner}" and "${s.id}"`);
    } else keyOwner.set(s.output.key, s.id);
  }
  for (const s of plan.subtasks) {
    for (const dep of s.dependsOn) {
      if (dep === s.id) errors.push(`subtask "${s.id}" depends on itself`);
      else if (!byId.has(dep)) errors.push(`subtask "${s.id}" depends on unknown subtask "${dep}"`);
    }
  }
  if (errors.length > 0) return errors;

  // Kahn's algorithm; anything left over is on or behind a cycle.
  const indegree = new Map(plan.subtasks.map((s) => [s.id, new Set(s.dependsOn).size]));
  const ready = plan.subtasks.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited += 1;
    for (const s of plan.subtasks) {
      if (new Set(s.dependsOn).has(id)) {
        const left = indegree.get(s.id)! - 1;
        indegree.set(s.id, left);
        if (left === 0) ready.push(s.id);
      }
    }
  }
  if (visited !== plan.subtasks.length) {
    const stuck = plan.subtasks.filter((s) => indegree.get(s.id)! > 0).map((s) => s.id);
    errors.push(`dependency cycle among: ${stuck.join(", ")}`);
    return errors;
  }

  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dep of byId.get(id)!.dependsOn) {
      if (!seen.has(dep)) {
        seen.add(dep);
        ancestors(dep, seen);
      }
    }
    return seen;
  };
  for (const s of plan.subtasks) {
    const upstream = new Set([...ancestors(s.id)].map((id) => byId.get(id)!.output.key));
    for (const key of s.inputKeys) {
      if (!upstream.has(key) && !external.has(key)) {
        errors.push(
          `subtask "${s.id}" reads "${key}", which no upstream subtask produces (add the producer to dependsOn)`,
        );
      }
    }
  }
  return errors;
}

/** Default output schema per investigation role; the executor keeps its report shape. */
const ROLE_DEFAULT_SCHEMAS: Record<string, Record<string, unknown>> = {
  inventory: INVENTORY_RESULT_JSON_SCHEMA,
  researcher: VULNERABILITY_RESEARCH_JSON_SCHEMA,
  reachability: REACHABILITY_RESULT_JSON_SCHEMA,
  impact: IMPACT_RESULT_JSON_SCHEMA,
  investigator: INVESTIGATOR_RESULT_JSON_SCHEMA,
};

/** Fills the output schema the planner left out: per-role investigation shapes, report for the executor. */
function withDefaultSchemas(plan: Plan): Plan {
  return {
    subtasks: plan.subtasks.map((s) => {
      if (s.output.schema) return { ...s, status: "pending" as const };
      const schema = s.sandboxValidation
        ? jsonSchemaOf(ValidationStepResultSchema)
        : (ROLE_DEFAULT_SCHEMAS[s.roleHint] ??
          (s.roleHint === "executor" ? REMEDIATION_REPORT_SCHEMA : GENERIC_OBJECT_SCHEMA));
      return { ...s, status: "pending" as const, output: { ...s.output, schema } };
    }),
  };
}

export const PLANNER_SYSTEM = `You are the planner for a dependency security investigation run on a GitHub repository. You decompose the brief into a DAG of subtasks. You have no tools; answer through write_result.

The investigation DAG template (one line per role, per plan.md section 1):
- inventory: lists what is actually installed, so "package present" is evidence, not assumption.
- researcher (vulnerability research): sources the vulnerability facts from independent databases so claims cross-check.
- reachability: answers whether the affected code can actually run in this repository; the core differentiator.
- impact: separates "is there a fix" from "is the fix safe", using release notes and real usage.
- investigator: reconciles the four evidence streams into one accountable conclusion per vulnerability.
- validator (code, never a slot): simulates the upgrade in isolation; a model here would only be an opinion.
- executor: acts outside the program only after human approval.

Rules:
- Each subtask has a unique "id", a "title", a "description" precise enough for an agent to act on alone, "dependsOn" (ids), and a "roleHint": "inventory", "researcher", "reachability", "impact", "investigator", or "executor". "critic" is not a subtask role - do not plan critic subtasks; every producing subtask is critiqued automatically.
- Follow the template waves: inventory and vulnerability research in parallel; then reachability and upgrade impact in parallel, each assessing every vulnerability the research found; then one investigator subtask synthesizing the findings with candidate remediations; then one sandbox validation subtask; then one executor subtask writing the report. Reachability and impact read the inventory and research keys; the investigator reads all four; validation reads the investigator and inventory keys; the executor reads the investigator and validation keys.
- The sandbox validation subtask is code-driven, not an agent slot: set "sandboxValidation": true on it (its roleHint is unused), give it an output key starting with "validation_", and describe which remediations to simulate. The run loop executes it with the isolated validator; no agent is routed.
- "output.key" is the unique blackboard key the subtask writes; "output.schema" is a JSON Schema for its value (omit it to accept the role's default investigation shape). "inputKeys" lists blackboard keys it reads, and every one must be produced by a subtask it depends on (directly or transitively).
- The graph must be acyclic. Keep it small: only subtasks that produce something a later subtask or the report needs.
- Give every subtask acceptance criteria inside its description.`;

function brief(request: PlanRequest): string {
  return [`Brief: ${request.brief}`, request.repoUrl ? `Repository: ${request.repoUrl}` : ""]
    .filter(Boolean)
    .join("\n");
}

async function requestPlan(deps: RoleDeps, task: string): Promise<Plan | string> {
  let output: unknown;
  try {
    ({ output } = await runRole(deps, {
      role: "planner",
      system: PLANNER_SYSTEM,
      task,
      inputs: {},
      tools: [],
      resultSchema: jsonSchemaOf(Plan),
      defaultMaxTurns: 4,
    }));
  } catch (err) {
    // A schema-invalid result is what the correction round is for; other failures are the supervisor's.
    if (err instanceof RoleRunError && err.status === "malformed") return err.message;
    throw err;
  }
  const parsed = Plan.safeParse(output);
  return parsed.success ? withDefaultSchemas(parsed.data) : parsed.error.message;
}

/** Asks for a plan, validates it, and allows exactly one correction round. */
async function planWithCorrection(
  deps: RoleDeps,
  task: string,
  validate: (plan: Plan) => string[],
): Promise<Plan> {
  let result = await requestPlan(deps, task);
  let errors =
    typeof result === "string" ? [`plan did not match the schema: ${result}`] : validate(result);
  if (errors.length === 0) return result as Plan;
  result = await requestPlan(
    deps,
    [
      task,
      "",
      "Your previous plan was invalid. Fix every problem and return the complete corrected plan.",
      "Problems:",
      ...errors.map((e) => `- ${e}`),
      typeof result === "string" ? "" : `Previous plan:\n${JSON.stringify(result, null, 2)}`,
    ].join("\n"),
  );
  errors =
    typeof result === "string" ? [`plan did not match the schema: ${result}`] : validate(result);
  if (errors.length > 0) throw new PlanValidationError(errors);
  return result as Plan;
}

/** Decomposes the brief into a validated subtask DAG. */
export function planBrief(deps: RoleDeps, request: PlanRequest): Promise<Plan> {
  return planWithCorrection(deps, brief(request), (plan) => validatePlan(plan));
}

/**
 * Replans after a permanent failure (the run loop, A8, decides when): replaces the failed subtask
 * and everything downstream of it, keeps the rest untouched, and returns the merged, validated plan.
 */
export async function replan(deps: RoleDeps, request: ReplanRequest): Promise<Plan> {
  const { plan, failedSubtaskId } = request;
  if (!plan.subtasks.some((s) => s.id === failedSubtaskId)) {
    throw new Error(`replan: unknown subtask "${failedSubtaskId}"`);
  }
  const replaced = new Set([failedSubtaskId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of plan.subtasks) {
      if (!replaced.has(s.id) && s.dependsOn.some((d) => replaced.has(d))) {
        replaced.add(s.id);
        grew = true;
      }
    }
  }
  const kept = plan.subtasks.filter((s) => !replaced.has(s.id));
  const boardKeys = Object.keys(request.blackboard);
  const task = [
    brief(request),
    "",
    `REPLAN. Subtask "${failedSubtaskId}" failed permanently: ${request.reason}`,
    `Return ONLY replacement subtasks for the failed subtask and these dependents: ${[...replaced].join(", ")}. Reach the same end goal by another route (other tools, other sources, or an explicit degraded result).`,
    `Already-planned subtasks that stay as they are (you may depend on them, not redefine them): ${JSON.stringify(kept.map((s) => ({ id: s.id, outputKey: s.output.key, status: s.status })))}`,
    `Blackboard state (keys you may read): ${JSON.stringify(
      Object.values(request.blackboard).map((e) => ({
        key: e.key,
        status: e.status,
        value: e.value,
      })),
    )}`,
  ].join("\n");
  const keptKeys = new Set(kept.map((s) => s.output.key));
  const replacements = await planWithCorrection(deps, task, (proposed) => {
    const merged: Plan = { subtasks: [...kept, ...proposed.subtasks] };
    const errors = validatePlan(merged, { externalKeys: boardKeys });
    for (const s of proposed.subtasks) {
      if (
        boardKeys.includes(s.output.key) ||
        (keptKeys.has(s.output.key) && !errors.some((e) => e.includes(s.output.key)))
      ) {
        errors.push(`output key "${s.output.key}" already exists; keys are never overwritten`);
      }
    }
    return errors;
  });
  return { subtasks: [...kept, ...replacements.subtasks] };
}
