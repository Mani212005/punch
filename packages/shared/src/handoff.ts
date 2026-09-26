import { z } from "zod";
import { SlotRole } from "./common.js";
import { BlackboardEntry } from "./blackboard.js";
import { FailureReason } from "./slots.js";
import { Subtask } from "./plan.js";

export const Finding = z.object({
  claim: z.string(),
  problem: z.string(),
  severity: z.enum(["info", "warning", "blocker"]).default("warning"),
  evidenceRef: z.string().optional(),
  /** A rejection may ask for new work; the run loop hands it to the planner as a targeted replan. */
  requestedTask: z
    .object({ title: z.string(), description: z.string(), roleHint: SlotRole.optional() })
    .optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ToolResultSummary = z.object({
  tool: z.string(),
  inputHash: z.string(),
  input: z.unknown(),
  output: z.unknown(),
});
export type ToolResultSummary = z.infer<typeof ToolResultSummary>;

/** What a replacement agent receives as `inputs` (plan.md 2.4). */
export const Handoff = z.object({
  subtask: Subtask,
  reason: FailureReason,
  predecessor: z.object({
    agentId: z.string(),
    displayName: z.string(),
    turnsUsed: z.number().int().nonnegative(),
    usdUsed: z.number().nonnegative(),
  }),
  inputs: z.record(z.string(), BlackboardEntry),
  cachedToolResults: z.array(ToolResultSummary),
  partialNotes: z.string().nullable(),
  criticFindings: z.array(Finding).nullable(),
  budget: z.object({
    stepsRemaining: z.number(),
    usdRemaining: z.number(),
    msRemaining: z.number(),
  }),
});
export type Handoff = z.infer<typeof Handoff>;
