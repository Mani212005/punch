import { z } from "zod";

/** Slot state machine, plan.md 2.1. Every transition is a trace event. */
export const SlotState = z.enum([
  "assigned",
  "running",
  "completed",
  "stalled",
  "failed",
  "rejected",
  "replacing",
  "exhausted",
  "degraded",
]);
export type SlotState = z.infer<typeof SlotState>;

export const FailureKind = z.enum(["stalled", "failed", "rejected", "operator_kill"]);
export type FailureKind = z.infer<typeof FailureKind>;

export const FailureReason = z.object({ kind: FailureKind, detail: z.string() });
export type FailureReason = z.infer<typeof FailureReason>;

export const StandbyEntry = z.object({
  agentId: z.string(),
  probability: z.number().min(0).max(1),
});
export type StandbyEntry = z.infer<typeof StandbyEntry>;
