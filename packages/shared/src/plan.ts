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
  assignee: z.enum(["researcher", "executor", "none_needed", "human"]).optional(),
  complexity: z.number().min(0).max(1).optional(),
  effort: Effort.optional(),
  status: SubtaskStatus.default("pending"),
});
export type Subtask = z.infer<typeof Subtask>;

/** Subtask DAG produced by the planner. */
export const Plan = z.object({ subtasks: z.array(Subtask).min(1) });
export type Plan = z.infer<typeof Plan>;
