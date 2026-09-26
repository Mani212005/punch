import { z } from "zod";
import { BlackboardEntry } from "./blackboard.js";
import { Effort, ErrorClass, Provenance, Role, SlotRole } from "./common.js";
import { Difficulty } from "./config.js";
import { Finding } from "./handoff.js";
import {
  Claim,
  EvidenceRecord,
  SandboxIsolation,
  SandboxStepName,
  SandboxStepResult,
  SandboxValidation,
} from "./investigation.js";
import { Subtask } from "./plan.js";
import { FailureReason, StandbyEntry } from "./slots.js";

const base = { runId: z.string(), seq: z.number().int().nonnegative(), ts: z.number() };

function event<K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({ ...base, kind: z.literal(kind), ...shape });
}

const who = { role: SlotRole, agentId: z.string(), subtaskId: z.string().optional() };
const Probability = z.object({ agentId: z.string(), probability: z.number().min(0).max(1) });
const RunStatus = z.enum(["completed", "degraded", "aborted", "failed"]);

export const HandoffSummary = z.object({
  inputKeys: z.array(z.string()),
  cachedResultCount: z.number().int().nonnegative(),
  partialNotes: z.string().nullable(),
  filesInspectedCount: z.number().int().nonnegative().optional(),
  evidenceRecordCount: z.number().int().nonnegative().optional(),
  criticFindings: z.array(Finding).nullable(),
  budget: z.object({
    stepsRemaining: z.number(),
    usdRemaining: z.number(),
    msRemaining: z.number(),
  }),
});
export type HandoffSummary = z.infer<typeof HandoffSummary>;

export const SelectionProvenance = z.object({
  provenance: Provenance,
  /** 1-based rank in the standby list, when chosen from it. */
  rank: z.number().int().positive().optional(),
  probability: z.number().min(0).max(1).optional(),
  skipped: z.array(z.object({ agentId: z.string(), reason: z.string() })).default([]),
});
export type SelectionProvenance = z.infer<typeof SelectionProvenance>;

/** Every kind listed in plan.md 3.7, discriminated on `kind`. */
export const TraceEvent = z.discriminatedUnion("kind", [
  event("run.started", {
    task: z.object({
      repoUrl: z.string(),
      brief: z.string().optional(),
      budgetUsd: z.number().optional(),
    }),
    mode: z.enum(["auto", "manual"]),
    budgets: z.object({ maxSteps: z.number(), maxUsd: z.number(), maxWallClockMs: z.number() }),
    orchestratorAgentId: z.string().optional(),
    chaos: z.array(z.string()).default([]),
  }),
  event("route.decided", {
    role: Role,
    subtaskId: z.string().optional(),
    agentId: z.string(),
    provenance: Provenance,
    probabilities: z.array(Probability),
    confidence: z.number().min(0).max(1),
    difficulty: Difficulty.optional(),
  }),
  event("route.skipped", { role: Role, reason: z.string() }),
  event("plan.created", { subtasks: z.array(Subtask) }),
  event("slot.assigned", {
    role: SlotRole,
    agentId: z.string(),
    provenance: Provenance,
    standby: z.array(StandbyEntry),
  }),
  event("agent.started", {
    ...who,
    attempt: z.number().int().positive(),
    effort: Effort.optional(),
  }),
  event("agent.heartbeat", who),
  event("agent.text", { ...who, text: z.string() }),
  event("agent.opaque_output", { ...who, text: z.string() }),
  event("tool.called", { ...who, callId: z.string(), tool: z.string(), input: z.unknown() }),
  event("tool.result", {
    callId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
    cached: z.boolean(),
    latencyMs: z.number().nonnegative(),
    retries: z.number().int().nonnegative().default(0),
    output: z.unknown().optional(),
    error: z.string().optional(),
    errorClass: ErrorClass.optional(),
  }),
  event("tool.retry", {
    callId: z.string(),
    tool: z.string(),
    attempt: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    errorClass: ErrorClass,
    error: z.string(),
  }),
  event("fallback.used", {
    tool: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
  event("blackboard.written", { key: z.string(), entry: BlackboardEntry }),
  event("slot.stalled", { ...who, silentMs: z.number().nonnegative(), nudged: z.boolean() }),
  event("slot.failed", { ...who, reason: FailureReason, classification: ErrorClass.optional() }),
  event("slot.rejected", {
    ...who,
    rejections: z.number().int().positive(),
    findings: z.array(Finding),
  }),
  event("slot.replacing", {
    role: SlotRole,
    subtaskId: z.string().optional(),
    failedAgentId: z.string(),
    replacementAgentId: z.string(),
    reason: FailureReason,
    handoff: HandoffSummary,
    selection: SelectionProvenance,
    /** Gap between last heartbeat and the takeover decision. */
    detectionMs: z.number().nonnegative().optional(),
  }),
  event("slot.replaced", {
    role: SlotRole,
    subtaskId: z.string().optional(),
    failedAgentId: z.string(),
    replacementAgentId: z.string(),
    takeoverMs: z.number().nonnegative(),
  }),
  event("slot.exhausted", {
    role: SlotRole,
    subtaskId: z.string().optional(),
    reason: z.string(),
    degradedKey: z.string().optional(),
  }),
  event("critic.verdict", {
    subtaskId: z.string(),
    agentId: z.string(),
    verdict: z.enum(["accepted", "rejected"]),
    attempt: z.number().int().positive(),
    findings: z.array(Finding),
  }),
  event("claim.recorded", { claim: Claim }),
  event("claim.verified", {
    claimId: z.string(),
    verifier: Claim.shape.verifier.unwrap(),
    rationale: z.string().optional(),
  }),
  event("claim.refuted", {
    claimId: z.string(),
    verifier: Claim.shape.verifier.unwrap(),
    rationale: z.string(),
  }),
  event("evidence.recorded", { ...who, evidence: EvidenceRecord }),
  event("sandbox.started", {
    findingId: z.string(),
    dependency: z.string(),
    from: z.string(),
    to: z.string(),
    isolation: SandboxIsolation,
  }),
  event("sandbox.step", {
    findingId: z.string(),
    phase: z.enum(["baseline", "candidate"]),
    step: SandboxStepName,
    result: SandboxStepResult,
  }),
  event("sandbox.finished", { findingId: z.string(), validation: SandboxValidation }),
  event("remediation.proposed", {
    findingId: z.string(),
    action: z.enum(["issue", "pull_request"]),
    dependency: z.string(),
    from: z.string(),
    to: z.string().nullable(),
    approvalId: z.string().optional(),
    summary: z.string(),
  }),
  event("approval.requested", {
    approvalId: z.string(),
    tool: z.string(),
    payload: z.unknown(),
  }),
  event("approval.granted", { approvalId: z.string(), decidedBy: z.string().optional() }),
  event("approval.denied", {
    approvalId: z.string(),
    decidedBy: z.string().optional(),
    reason: z.string().optional(),
  }),
  event("budget.checked", {
    steps: z.object({ used: z.number(), max: z.number() }),
    usd: z.object({ used: z.number(), max: z.number() }),
    ms: z.object({ used: z.number(), max: z.number() }),
    exceeded: z.enum(["steps", "usd", "wallClock"]).nullable(),
  }),
  event("replan.triggered", { subtaskId: z.string(), reason: z.string() }),
  event("compensation.ran", { action: z.string(), ok: z.boolean(), detail: z.string().optional() }),
  event("run.finished", {
    status: RunStatus,
    summary: z.string().optional(),
    reportKey: z.string().optional(),
  }),
]);
export type TraceEvent = z.infer<typeof TraceEvent>;
export type TraceEventKind = TraceEvent["kind"];

export const TRACE_EVENT_KINDS = TraceEvent.options.map(
  (o) => o.shape.kind.value,
) as TraceEventKind[];
