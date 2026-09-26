import { z } from "zod";

/**
 * Chaos profile grammar from plan.md 2.6 plus the per-tool profiles from 3.6.
 * This is intentionally wider than the shared `ChaosProfile` schema (which
 * predates the newer roles and the timeout/hallucinate/rate-limit modes):
 * anything not matching is rejected with a 400 that names the bad profile.
 */
const CHAOS_PATTERNS: RegExp[] = [
  /^provider-down:.+$/,
  /^rate-limit:.+$/,
  /^stall:(planner|inventory|researcher|reachability|impact|investigator|executor|critic)$/,
  /^timeout:(planner|inventory|researcher|reachability|impact|investigator|executor|critic)$/,
  /^garbage:(planner|inventory|researcher|reachability|impact|investigator|executor|critic)$/,
  /^hallucinate:(planner|inventory|researcher|reachability|impact|investigator|executor|critic)$/,
  /^kill-after:(planner|inventory|researcher|reachability|impact|investigator|executor|critic):\d+$/,
  /^tool:.+:(500|hang|truncate|empty)$/,
];

export function isValidChaosProfile(profile: string): boolean {
  return CHAOS_PATTERNS.some((pattern) => pattern.test(profile));
}

export const SetChaosBody = z.object({ profiles: z.array(z.string().min(1)) });

export const CreateRunBody = z.object({
  repoUrl: z.string().min(1).optional(),
  /** Path to a recorded fixture directory (offline replay); server-side only. */
  fixture: z.string().min(1).optional(),
  brief: z.string().min(1).optional(),
  chaos: z.array(z.string().min(1)).default([]),
  unattended: z.boolean().optional(),
  budgetUsd: z.number().nonnegative().optional(),
  mode: z.enum(["auto", "manual"]).optional(),
  /** Client-chosen run id, so chaos can be set for it before it starts. */
  runId: z.string().min(1).optional(),
});

export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const AnswerApprovalBody = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().optional(),
});

export const CreateSessionBody = z.object({
  orchestratorAgentId: z.string().min(1).optional(),
  mode: z.enum(["auto", "manual"]).optional(),
});

export const SendMessageBody = z.object({ text: z.string().min(1) });
