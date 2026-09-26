import { z } from "zod";
import { Effort, SlotRole } from "./common.js";

export const SubtaskStatus = z.enum(["pending", "running", "completed", "degraded", "failed"]);
export type SubtaskStatus = z.infer<typeof SubtaskStatus>;

export const Subtask = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()),
  roleHint: SlotRole,
  /** Blackboard key the subtask must produce, with the schema it must satisfy. */
  output: z.object({ key: z.string(), schema: z.record(z.string(), z.unknown()).optional() }),
  inputKeys: z.array(z.string()).default([]),
  assignee: z
    .enum([
      "inventory",
      "researcher",
      "reachability",
      "impact",
      "investigator",
      "executor",
      "none_needed",
      "human",
    ])
    .optional(),
  complexity: z.number().min(0).max(1).optional(),
  effort: Effort.optional(),
  /**
   * Code-driven sandbox validation step (plan.md 8.4, E2): the run loop executes this subtask
   * with the E5 validator instead of routing it to an agent slot. The trace names role
   * `validator`. `roleHint` is still required by the schema but unused for these steps.
   */
  sandboxValidation: z.boolean().optional(),
  status: SubtaskStatus.default("pending"),
});
export type Subtask = z.infer<typeof Subtask>;

/** Subtask DAG produced by the planner. */
export const Plan = z.object({ subtasks: z.array(Subtask).min(1) });
export type Plan = z.infer<typeof Plan>;
