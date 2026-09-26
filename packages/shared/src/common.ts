import { z } from "zod";

/**
 * `researcher` is the vulnerability research role. The validator (sandbox) is code, not a
 * role: it never fills an LLM slot (plan.md 1).
 */
export const Role = z.enum([
  "orchestrator",
  "planner",
  "inventory",
  "researcher",
  "reachability",
  "impact",
  "investigator",
  "critic",
  "executor",
]);
export type Role = z.infer<typeof Role>;

/** Roles that occupy a run slot (the orchestrator is a session, not a slot). */
export const SlotRole = z.enum([
  "planner",
  "inventory",
  "researcher",
  "reachability",
  "impact",
  "investigator",
  "critic",
  "executor",
]);
export type SlotRole = z.infer<typeof SlotRole>;

export const CostTier = z.enum(["low", "medium", "high"]);
export type CostTier = z.infer<typeof CostTier>;

export const Effort = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof Effort>;

/** Where a routing or replacement choice came from (plan.md 2.3, 3.5, 4.2). */
export const Provenance = z.enum(["pin", "rule", "jev", "chain", "standby", "fresh"]);
export type Provenance = z.infer<typeof Provenance>;

export const ErrorClass = z.enum(["transient", "permanent", "malformed", "not_found"]);
export type ErrorClass = z.infer<typeof ErrorClass>;
