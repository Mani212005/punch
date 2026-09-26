import { z } from "zod";

export const Evidence = z.object({
  source: z.string(),
  /** The statement this evidence is cited for; the critic checks each one (plan.md 3.5). */
  claim: z.string().optional(),
  url: z.string().optional(),
  quote: z.string().optional(),
  toolCallId: z.string().optional(),
  traceSeq: z.number().int().nonnegative().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Typed, evidence-linked, never overwritten: a rewrite is a new version. */
export const BlackboardEntry = z.object({
  key: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["ok", "degraded"]),
  value: z.unknown(),
  evidence: z.array(Evidence),
  writtenBy: z.object({ role: z.string(), agentId: z.string(), subtaskId: z.string().optional() }),
  ts: z.number(),
});
export type BlackboardEntry = z.infer<typeof BlackboardEntry>;
