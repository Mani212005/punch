import { z } from "zod";
import { SlotRole } from "./common.js";
import { Config } from "./config.js";
import { Provenance } from "./common.js";

/** Payload schemas for the engine API, plan.md 3.8. */

export const HealthCheckResult = z.object({ ok: z.boolean(), detail: z.string() });
export type HealthCheckResult = z.infer<typeof HealthCheckResult>;

export const ConfigResponse = z.object({ config: Config });
export const PutConfigRequest = z.object({ config: Config });
export const ConfigIssue = z.object({ path: z.string(), message: z.string() });
export const PutConfigResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), issues: z.array(ConfigIssue) }),
]);

export const Mode = z.enum(["auto", "manual"]);

export const CreateSessionRequest = z.object({
  orchestratorAgentId: z.string().optional(),
  mode: Mode.optional(),
});
export const Session = z.object({
  id: z.string(),
  orchestratorAgentId: z.string(),
  mode: Mode,
  createdAt: z.number(),
  runIds: z.array(z.string()),
});
export type Session = z.infer<typeof Session>;
export const SendMessageRequest = z.object({ text: z.string().min(1) });

export const AssignmentRequest = z.object({
  selections: z
    .array(z.object({ role: SlotRole, agentId: z.string(), provenance: Provenance.optional() }))
    .default([]),
  confirmed: z.boolean().optional(),
});
export const ApprovalAnswerRequest = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().optional(),
});

/** Chaos profile grammar from plan.md 2.6 and 3.6. */
export const ChaosProfile = z.union([
  z.string().regex(/^provider-down:.+$/),
  z.string().regex(/^stall:(planner|researcher|executor|critic)$/),
  z.string().regex(/^garbage:(planner|researcher|executor|critic)$/),
  z.string().regex(/^kill-after:(planner|researcher|executor|critic):\d+$/),
  z.string().regex(/^tool:.+:(500|hang|truncate|empty)$/),
]);
export type ChaosProfile = z.infer<typeof ChaosProfile>;
export const SetChaosRequest = z.object({ profiles: z.array(ChaosProfile) });

export const KillSlotParams = z.object({ id: z.string(), role: SlotRole });
export const OkResponse = z.object({ ok: z.literal(true) });

export const RunSummary = z.object({
  id: z.string(),
  repoUrl: z.string(),
  status: z.enum([
    "pending",
    "running",
    "awaiting_approval",
    "completed",
    "degraded",
    "aborted",
    "failed",
  ]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;
export const ListRunsResponse = z.object({ runs: z.array(RunSummary) });
