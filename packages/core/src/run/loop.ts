import type {
  AgentEntry,
  AgentEvent,
  BlackboardEntry,
  Config,
  Effort,
  FailureReason,
  Handoff,
  Plan,
  Provider,
  SlotRole,
  Subtask,
  SubtaskStatus,
  TraceEvent,
} from "@punch/shared";
import { NO_CHAOS } from "../adapters/agent.js";
import { selectApprovalGate, type RunApprovalOptions } from "../approval.js";
import { Blackboard } from "../blackboard.js";
import { BudgetMeter, type BudgetExceededReason } from "../budget.js";
import { PlanValidationError, planBrief, replan } from "../planner.js";
import {
  RoleRunError,
  ToolLedger,
  commitDraft,
  createRoleToolExecutor,
  type Draft,
  type ProducerInput,
  type RoleDeps,
} from "../roles/common.js";
import { acceptedVerdict, reviewDraft } from "../roles/critic.js";
import { runExecutor, REMEDIATION_REPORT_SCHEMA } from "../roles/executor.js";
import { runResearcher } from "../roles/researcher.js";
import { produceWithReview } from "../roles/review.js";
import type { Jev } from "../router/jev.js";
import { ROUTED_ROLES } from "../router/jev.js";
import { classifyError } from "../router/classify-error.js";
import { routeSubtask, routeTask, type RoutePlan, type RouteEvent } from "../router/policy.js";
import { chaosAdapter, hasSlotChaos, parseSlotChaos } from "../slots/chaos.js";
import { watchKillRequests } from "../slots/control.js";
import { AttemptLog } from "../slots/handoff.js";
import { AttemptAborted, SlotSupervisor, type AttemptWatch } from "../slots/supervisor.js";
import { ToolCache } from "../tools/cache.js";
import { parseChaosProfile } from "../tools/chaos.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import { TraceWriter, type TraceEventInput } from "../trace/writer.js";
import type { AdapterRegistry } from "./registry.js";
import { AdapterUnavailableError } from "./registry.js";
import { Slot, type EmitEvent, type EventBody } from "./slot.js";
import { createGuardedToolRunner, raceAbort } from "./tools.js";

/** What a role does with a subtask. New roles register here; the loop never names a role itself. */
export interface RoleHandler {
  produce(deps: RoleDeps, input: ProducerInput): Promise<Draft>;
  /** Whether the critic reviews this role's drafts. Default true. */
  reviewed?: boolean;
}

export type RoleRegistry = Partial<Record<SlotRole, RoleHandler>>;

export const DEFAULT_ROLE_REGISTRY: RoleRegistry = {
  researcher: { produce: runResearcher },
  executor: { produce: runExecutor },
};

export interface RunLoopOptions {
  runId?: string;
  task: { repoUrl: string; brief?: string; budgetUsd?: number };
  config: Config;
  mode?: "auto" | "manual";
  jev: Jev;
  adapters: AdapterRegistry;
  roles?: RoleRegistry;
  /** HTTP clients for the A3 tools; fixture runs inject recorded ones. */
  clients?: ToolExecutionContext["clients"];
  /** Chaos profiles, plan.md 2.6 and 3.6 (`tool:<name>:<500|hang|truncate|empty>`, `provider-down:<id>`...). */
  chaos?: string[];
  approval?: RunApprovalOptions;
  runsDir?: string;
  signal?: AbortSignal;
  toolTimeoutMs?: number;
  maxConcurrency?: number;
  wrapUpTimeoutMs?: number;
  /** Called in auto mode when Jev's confidence is low; return false to abort. */
  confirmRouting?: (plan: RoutePlan) => boolean | Promise<boolean>;
  onEvent?: (event: TraceEvent) => void;
  now?: () => number;
  /** Replans on a permanent failure with dependents (plan.md 3.6 step 7). */
  maxFailureReplans?: number;
  /** Separate, bounded path: replans triggered by a critic rejection that requests a new task. */
  maxRejectionReplans?: number;
  /** Called once with the run's controls, e.g. for the HTTP API's kill endpoint. */
  onReady?: (handle: RunHandle) => void;
  /** Slot supervisor timing (plan.md 2.1/2.2); the defaults come from `config.policy.stallAfterMs`. */
  attemptTimeoutMs?: number;
  nudgeGraceMs?: number;
  stallCheckIntervalMs?: number;
  /** Poll `runs/<id>/control` for `punch kill` requests from another process. Default true. */
  killChannel?: boolean;
}

/** What a caller can do to a live run. */
export interface RunHandle {
  runId: string;
  /** Operator kill of the agent working in the slot; false when nothing is running there. */
  kill(role: SlotRole, detail?: string): boolean;
}

export type RunStatus = "completed" | "degraded" | "aborted" | "failed";

export interface RunResult {
  runId: string;
  status: RunStatus;
  summary: string;
  tracePath: string;
  reportKey?: string;
  report?: BlackboardEntry;
  plan: Plan | null;
  blackboard: Record<string, BlackboardEntry>;
  slots: Slot[];
  stoppedBy: string | null;
  events: TraceEvent[];
  traceErrors: string[];
}

class StopError extends Error {
  constructor() {
    super("run stopped");
    this.name = "StopError";
  }
}

type FailureClass = "transient" | "permanent" | "malformed" | "not_found";

class SubtaskFailure extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.name = "SubtaskFailure";
  }
}

/** The slot's replacements ran out; the supervisor already traced `slot.exhausted`. */
class SlotExhaustedError extends SubtaskFailure {
  constructor(failureClass: FailureClass, message: string) {
    super(failureClass, message);
    this.name = "SlotExhaustedError";
  }
}

/** The planner works outside the subtask DAG; its handoff still needs a subtask to name. */
const PLAN_SUBTASK: Subtask = {
  id: "plan",
  title: "Plan the run",
  description: "Decompose the brief into a subtask DAG.",
  dependsOn: [],
  roleHint: "planner",
  output: { key: "plan" },
  inputKeys: [],
  status: "running",
};

const SETTLED: readonly SubtaskStatus[] = ["completed", "degraded", "failed"];
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function defaultBrief(repoUrl: string): string {
  return `Triage the dependencies of ${repoUrl} for known vulnerabilities and write a prioritized remediation report: vulnerable dependencies, fixed versions, breaking-change risk of each upgrade, recommended action.`;
}

function newRunId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The run loop (plan.md 3, A8). Routes once, plans a DAG, dispatches subtasks in dependency order
 * (independent ones concurrently) each on its role's slot, writes the blackboard, has the critic
 * review, gates irreversible tools, stops on any budget cap with one wrap-up executor turn, and
 * records every step to `runs/<id>/trace.jsonl`. It never throws for a run-time failure: whatever
 * happens, `run.finished` is the last event.
 */
export async function runLoop(options: RunLoopOptions): Promise<RunResult> {
  const now = options.now ?? (() => Date.now());
  const { config, jev, task } = options;
  const runId = options.runId ?? newRunId(now());
  const mode = options.mode ?? config.defaults.mode;
  const brief = task.brief ?? defaultBrief(task.repoUrl);
  const agents = new Map<string, AgentEntry>(config.agents.map((a) => [a.id, a]));
  const providers = new Map<string, Provider>(config.providers.map((p) => [p.id, p]));
  const roleHandlers: RoleRegistry = { ...DEFAULT_ROLE_REGISTRY, ...options.roles };
  const budgets = {
    ...config.budgets,
    ...(task.budgetUsd !== undefined ? { maxUsd: task.budgetUsd } : {}),
  };
  const chaosProfiles = options.chaos ?? [];
  const toolChaos = parseChaosProfile(chaosProfiles);

  // -- trace ---------------------------------------------------------------
  const writer = new TraceWriter({
    runId,
    ...(options.runsDir ? { dir: options.runsDir } : {}),
    apiKeyEnvs: config.providers.flatMap((p) => ("apiKeyEnv" in p ? [p.apiKeyEnv] : [])),
    now,
  });
  const events: TraceEvent[] = [];
  const traceErrors: string[] = [];
  writer.subscribe((event) => {
    events.push(event);
    options.onEvent?.(event);
  });
  /** Set once `run.finished` is written: work abandoned by a stop may still be winding down. */
  let sealed = false;
  const emit: EmitEvent = (body: EventBody) => {
    if (sealed) return;
    if (body.kind === "run.finished") sealed = true;
    writer.write(body as TraceEventInput).catch((err: unknown) => {
      traceErrors.push(`${body.kind}: ${errText(err)}`);
    });
  };
  /** Tool layer and blackboard events arrive with their own runId/seq/ts; the writer re-stamps them. */
  const sink = (event: TraceEvent): void => {
    const { runId: _r, seq: _s, ts: _t, ...body } = event;
    void _r;
    void _s;
    void _t;
    emit(body as EventBody);
  };

  // -- budget and stopping -------------------------------------------------
  let stoppedBy: string | null = null;
  const stop = new AbortController();
  const markStop = (reason: string): void => {
    stoppedBy ??= reason;
    if (!stop.signal.aborted) stop.abort(new StopError());
  };
  const emitBudget = (exceeded?: BudgetExceededReason): void => {
    const payload = meter.getBudgetCheckedPayload();
    emit({ kind: "budget.checked", ...payload, exceeded: exceeded ?? payload.exceeded });
  };
  const meter = new BudgetMeter({
    budgets,
    pricingMap: (id) => agents.get(id)?.pricing,
    now,
    onExceeded: (reason) => {
      markStop(reason);
      emitBudget(reason);
    },
  });
  const runSignal = AbortSignal.any([
    meter.signal,
    stop.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  options.signal?.addEventListener("abort", () => markStop("operator"), { once: true });
  const wallTimer = setTimeout(() => meter.check(), budgets.maxWallClockMs);
  wallTimer.unref();
  /** Steps are reserved for the wrap-up turn: stop while one is left. */
  const reserveCheck = (): void => {
    if (meter.isWrapUpReserved && !meter.wrapUpActive && !stop.signal.aborted) {
      markStop("steps");
      emitBudget("steps");
    }
  };

  // -- shared run state ----------------------------------------------------
  const blackboard = new Blackboard({ runId, traceSink: sink, clock: now });
  const cache = new ToolCache();
  const slotChaos = parseSlotChaos(chaosProfiles);
  const slots = new Map<SlotRole, Slot>();
  const subtasks = new Map<string, Subtask>();
  const ledgers = new Map<string, ToolLedger>();
  const approvalGate = selectApprovalGate(options.approval);
  const guardedRun = createGuardedToolRunner({
    timeoutMs: options.toolTimeoutMs ?? 60_000,
    emit,
  });
  const toolContext: ToolExecutionContext = {
    runId,
    cache,
    chaos: toolChaos,
    approvalGate,
    traceSink: sink,
    ...(options.clients ? { clients: options.clients } : {}),
  };
  const supervisor = new SlotSupervisor({
    config,
    emit,
    now,
    executorAgentId: () => slots.get("executor")?.agentId,
    budget: () => {
      const b = meter.getBudgetCheckedPayload();
      return {
        stepsRemaining: Math.max(0, b.steps.max - b.steps.used),
        usdRemaining: Math.max(0, b.usd.max - b.usd.used),
        msRemaining: Math.max(0, b.ms.max - b.ms.used),
      };
    },
    freshRouting: async (role, exclude) => {
      try {
        const narrowed = {
          ...config,
          agents: config.agents.filter((a) => !exclude.includes(a.id)),
        };
        const routed = await routeTask(jev, { ...routeInput([role]), config: narrowed });
        const found = routed.assignments.find((a) => a.role === role);
        return found ? { agentId: found.agentId } : null;
      } catch {
        return null;
      }
    },
    ...(options.attemptTimeoutMs !== undefined
      ? { attemptTimeoutMs: options.attemptTimeoutMs }
      : {}),
    ...(options.nudgeGraceMs !== undefined ? { nudgeGraceMs: options.nudgeGraceMs } : {}),
    ...(options.stallCheckIntervalMs !== undefined
      ? { checkIntervalMs: options.stallCheckIntervalMs }
      : {}),
  });
  const handle: RunHandle = { runId, kill: (role, detail) => supervisor.kill(role, detail) };
  const stopKillWatch =
    options.killChannel === false
      ? () => {}
      : watchKillRequests(options.runsDir ?? "runs", runId, (req) =>
          supervisor.kill(req.role, req.detail ?? "killed by the operator"),
        );
  let currentPlan: Plan | null = null;
  let failureReplans = 0;
  let rejectionReplans = 0;

  const currentPlanValue = (): Plan => ({ subtasks: [...subtasks.values()] });
  const setStatus = (id: string, status: SubtaskStatus): void => {
    const s = subtasks.get(id);
    if (s) subtasks.set(id, { ...s, status });
  };

  const finish = async (
    status: RunStatus,
    summary: string,
    report?: BlackboardEntry,
  ): Promise<RunResult> => {
    clearTimeout(wallTimer);
    stopKillWatch();
    emitBudget();
    emit({
      kind: "run.finished",
      status,
      summary,
      ...(report ? { reportKey: report.key } : {}),
    });
    await writer.flush();
    await writer.close();
    return {
      runId,
      status,
      summary,
      tracePath: writer.filePath,
      ...(report ? { reportKey: report.key, report } : {}),
      plan: currentPlan ? currentPlanValue() : null,
      blackboard: blackboard.getAll(),
      slots: [...slots.values()],
      stoppedBy,
      events,
      traceErrors,
    };
  };

  emit({
    kind: "run.started",
    task: {
      repoUrl: task.repoUrl,
      ...(task.brief ? { brief: task.brief } : {}),
      ...(task.budgetUsd !== undefined ? { budgetUsd: task.budgetUsd } : {}),
    },
    mode,
    budgets,
    ...(config.defaults.orchestratorAgentId
      ? { orchestratorAgentId: config.defaults.orchestratorAgentId }
      : {}),
    chaos: chaosProfiles,
  });

  // -- routing: once, then a slot per role ---------------------------------
  const routeEmit = (event: RouteEvent): void => emit(event);
  const makeSlots = (routePlan: RoutePlan): void => {
    for (const a of routePlan.assignments) {
      if (slots.has(a.role)) continue;
      const slot = new Slot({
        role: a.role,
        agentId: a.agentId,
        provenance: a.provenance,
        standby: a.standby,
        emit,
        now,
      });
      slots.set(a.role, slot);
      slot.announce();
    }
  };
  const routeInput = (roles?: SlotRole[]) => ({
    config,
    mode,
    task: {
      brief,
      expectedOutputs: ["prioritized remediation report"],
      irreversibleActionsPossible: true,
    },
    emit: routeEmit,
    signal: runSignal,
    ...(roles ? { roles } : {}),
  });

  let routePlan: RoutePlan;
  try {
    routePlan = await routeTask(jev, routeInput([...ROUTED_ROLES]));
  } catch (err) {
    return finish("failed", `routing failed: ${errText(err)}`);
  }
  if (routePlan.unfilled.length > 0) {
    return finish("failed", `no agent can fill: ${routePlan.unfilled.join(", ")}`);
  }
  if (routePlan.needsConfirmation && options.confirmRouting) {
    if (!(await options.confirmRouting(routePlan))) {
      return finish("aborted", "routing was not confirmed");
    }
  }
  makeSlots(routePlan);
  options.onReady?.(handle);

  /** Slots follow the roles the plan names; a role nobody routed yet is routed on first use. */
  const ensureSlot = async (role: SlotRole): Promise<Slot> => {
    const existing = slots.get(role);
    if (existing) return existing;
    const extra = await routeTask(jev, routeInput([role]));
    makeSlots(extra);
    const slot = slots.get(role);
    if (!slot) throw new AdapterUnavailableError(`no agent can fill the ${role} role`);
    return slot;
  };

  // -- running an agent on a slot ------------------------------------------
  /** What supervision needs to see of an attempt: its heartbeat clock and its accumulated trail. */
  interface AttemptContext {
    watch: AttemptWatch;
    log: AttemptLog;
    handoff?: Handoff | undefined;
  }

  const agentEventHandler =
    (slot: Slot, subtaskId: string | undefined, signal: AbortSignal, attempt?: AttemptContext) =>
    (event: AgentEvent): void => {
      // Work abandoned by a stop or a takeover keeps running in the background; it no longer
      // counts or traces.
      if (signal.aborted) return;
      attempt?.watch.beat();
      attempt?.log.observe(event);
      slot.beat(subtaskId);
      const who = {
        role: slot.role,
        agentId: slot.agentId,
        ...(subtaskId !== undefined ? { subtaskId } : {}),
      };
      switch (event.type) {
        case "text":
          emit({ kind: "agent.text", ...who, text: event.text });
          break;
        case "opaque_output":
          emit({ kind: "agent.opaque_output", ...who, text: event.text });
          break;
        case "usage": {
          const cost = meter.recordUsage(slot.agentId, event.usage);
          slot.noteTurn(cost.costUsd);
          reserveCheck();
          break;
        }
        case "tool_call":
          meter.recordStep();
          reserveCheck();
          break;
        default:
          break;
      }
    };

  const buildDeps = (
    slot: Slot,
    subtaskId: string | undefined,
    effort: Effort,
    ledger: ToolLedger,
    signal: AbortSignal,
    attempt?: AttemptContext,
  ): RoleDeps => {
    const agent = agents.get(slot.agentId);
    const provider = agent ? providers.get(agent.providerId) : undefined;
    if (!agent || !provider) {
      throw new AdapterUnavailableError(`agent ${slot.agentId} or its provider is not in config`);
    }
    const executeTool = createRoleToolExecutor({
      role: slot.role,
      blackboard,
      ledger,
      agentId: slot.agentId,
      ...(subtaskId ? { subtaskId } : {}),
      context: toolContext,
      approvalGate,
      run: guardedRun,
    });
    const created = options.adapters.create({ agent, provider, executeTool, chaos: NO_CHAOS });
    // Agent chaos is applied here, once, for every adapter kind (plan.md 2.6).
    const adapter = hasSlotChaos(slotChaos)
      ? chaosAdapter(created, {
          chaos: slotChaos,
          providerId: provider.id,
          isFirstAgent: () => slot.replaced.length === 0,
        })
      : created;
    return {
      agent: { agentId: agent.id, displayName: agent.displayName, adapter },
      ledger,
      signal,
      effort,
      onEvent: agentEventHandler(slot, subtaskId, signal, attempt),
      ...(attempt?.handoff ? { handoff: attempt.handoff } : {}),
    };
  };

  /** One agent invocation: start the slot, charge a step, run, and stop cleanly on abort. */
  const invoke = async <T>(
    slot: Slot,
    subtaskId: string | undefined,
    effort: Effort,
    ledger: ToolLedger,
    fn: (deps: RoleDeps) => Promise<T>,
    attempt: AttemptContext,
  ): Promise<T> => {
    if (runSignal.aborted || !meter.canExecuteTurn()) throw new StopError();
    slot.start(subtaskId, effort);
    meter.recordStep();
    reserveCheck();
    // The attempt ends on a stop, or on the supervisor's stall, timeout and kill.
    const attemptSignal = AbortSignal.any([runSignal, attempt.watch.signal]);
    const deps = buildDeps(slot, subtaskId, effort, ledger, attemptSignal, attempt);
    try {
      return await raceAbort(fn(deps), attemptSignal);
    } catch (err) {
      if (runSignal.aborted) throw new StopError();
      throw err;
    }
  };

  const classifyFailure = async (err: unknown): Promise<SubtaskFailure> => {
    if (err instanceof AdapterUnavailableError) return new SubtaskFailure("permanent", err.message);
    if (err instanceof RoleRunError) {
      if (err.status === "malformed") return new SubtaskFailure("malformed", err.message);
      if (err.status !== "error") return new SubtaskFailure("permanent", err.message);
    }
    const { errorClass } = await classifyError({ text: errText(err) }, { jev, signal: runSignal });
    return new SubtaskFailure(errorClass, errText(err));
  };

  /** plan.md 2.2: transient retries the same agent twice, malformed once; the rest fails the work. */
  const withRetries = async <T>(run: () => Promise<T>): Promise<T> => {
    let transient = 0;
    let malformed = 0;
    for (;;) {
      try {
        return await run();
      } catch (err) {
        if (err instanceof StopError || runSignal.aborted) throw new StopError();
        // Ended by the supervisor (stall, timeout, kill): retrying the same agent is pointless.
        if (err instanceof AttemptAborted) throw err;
        const failure = await classifyFailure(err);
        if (failure.failureClass === "transient" && transient < 2) transient += 1;
        else if (failure.failureClass === "malformed" && malformed < 1) malformed += 1;
        else throw failure;
      }
    }
  };

  /**
   * Runs work on the slot's agent under supervision (plan.md 2). When the attempt fails for good
   * (error after retries, stall, timeout, operator kill) the supervisor replaces the agent and the
   * same work continues on the replacement with a handoff, until it succeeds or the slot is
   * exhausted. Rejections are handled by the caller, which owns the critic loop.
   */
  const supervised = async <T>(
    slot: Slot,
    subtask: Subtask,
    effortIn: Effort,
    ledger: ToolLedger,
    log: AttemptLog,
    work: (deps: RoleDeps) => Promise<T>,
    initialHandoff?: Handoff,
  ): Promise<T> => {
    let effort = effortIn;
    let handoff = initialHandoff;
    const subtaskId = subtask.id === PLAN_SUBTASK.id ? undefined : subtask.id;
    for (;;) {
      const attemptAgentId = slot.agentId;
      let reason: FailureReason;
      let classification: FailureClass | undefined;
      let errorText: string | undefined;
      let detectedAt = now();
      let lastBeatAt = detectedAt;
      if (supervisor.providerDown(attemptAgentId)) {
        const providerId = agents.get(attemptAgentId)?.providerId ?? "unknown";
        errorText = `provider ${providerId} is down (recent availability failure); not started`;
        reason = { kind: "failed", detail: errorText };
      } else {
        const watch = supervisor.watch(slot, { subtaskId });
        try {
          return await withRetries(() =>
            invoke(slot, subtaskId, effort, ledger, work, { watch, log, handoff }),
          );
        } catch (err) {
          if (err instanceof StopError || runSignal.aborted) throw new StopError();
          const cause = watch.cause();
          lastBeatAt = watch.lastBeatAt();
          if (cause) {
            detectedAt = cause.at;
            reason = {
              kind:
                cause.kind === "operator_kill"
                  ? "operator_kill"
                  : cause.kind === "stalled"
                    ? "stalled"
                    : "failed",
              detail: cause.detail,
            };
          } else {
            const failure = err instanceof SubtaskFailure ? err : await classifyFailure(err);
            reason = { kind: "failed", detail: failure.message };
            classification = failure.failureClass;
            errorText = failure.message;
          }
        } finally {
          watch.stop();
        }
      }
      const takeover = await supervisor.takeover({
        slot,
        attemptAgentId,
        subtask,
        reason,
        classification,
        ...(errorText !== undefined ? { errorText } : {}),
        lastBeatAt,
        detectedAt,
        log,
        inputs: blackboard.getInputs(subtask.inputKeys, { allowMissing: true }),
        effort,
      });
      if (!takeover) throw new SlotExhaustedError(classification ?? "permanent", reason.detail);
      handoff = takeover.handoff;
      effort = takeover.effort ?? effort;
    }
  };

  // -- planning ------------------------------------------------------------
  const plannerSlot = slots.get("planner")!;
  const plannerLog = new AttemptLog();
  const plannerLedger = new ToolLedger();
  const adoptPlan = (plan: Plan): void => {
    subtasks.clear();
    for (const s of plan.subtasks) subtasks.set(s.id, s);
    currentPlan = plan;
    emit({ kind: "plan.created", subtasks: plan.subtasks });
  };
  try {
    const plan = await supervised(
      plannerSlot,
      PLAN_SUBTASK,
      "medium",
      plannerLedger,
      plannerLog,
      (deps) => planBrief(deps, { brief, repoUrl: task.repoUrl }),
    );
    plannerSlot.complete(undefined);
    adoptPlan(plan);
  } catch (err) {
    if (err instanceof StopError) return wrapUpAndFinish();
    const reason =
      err instanceof PlanValidationError || err instanceof SubtaskFailure
        ? err.message
        : errText(err);
    if (!(err instanceof SlotExhaustedError)) {
      plannerSlot.fail(undefined, { kind: "failed", detail: reason });
    }
    return finish("failed", `planning failed: ${reason}`);
  }

  // -- dispatch ------------------------------------------------------------
  const dependents = (id: string): string[] =>
    [...subtasks.values()].filter((s) => s.dependsOn.includes(id)).map((s) => s.id);

  const writeDegraded = (subtask: Subtask, role: SlotRole, agentId: string, reason: string) => {
    try {
      blackboard.writeDegraded({
        key: subtask.output.key,
        value: { unknown: true, reason },
        evidence: [],
        writtenBy: { role, agentId, subtaskId: subtask.id },
      });
    } catch {
      // The key already holds an entry; keys are never overwritten.
    }
  };

  const tryReplan = async (subtask: Subtask, reason: string): Promise<boolean> => {
    emit({ kind: "replan.triggered", subtaskId: subtask.id, reason });
    try {
      const merged = await supervised(
        plannerSlot,
        PLAN_SUBTASK,
        "high",
        plannerLedger,
        plannerLog,
        (deps) =>
          replan(deps, {
            brief,
            repoUrl: task.repoUrl,
            plan: currentPlanValue(),
            failedSubtaskId: subtask.id,
            reason,
            blackboard: blackboard.getAll(),
          }),
      );
      plannerSlot.complete(undefined);
      adoptPlan(merged);
      return true;
    } catch (err) {
      if (err instanceof StopError) throw err;
      if (!(err instanceof SlotExhaustedError)) {
        plannerSlot.fail(undefined, { kind: "failed", detail: errText(err) });
      }
      return false;
    }
  };

  const runSubtask = async (subtask: Subtask): Promise<void> => {
    setStatus(subtask.id, "running");
    const ledger = new ToolLedger();
    ledgers.set(subtask.id, ledger);

    // Per-subtask routing: assignee from Jev, effort from complexity (plan.md 3.5).
    let role: SlotRole = subtask.roleHint;
    let effort: Effort = "medium";
    let assignee: string = subtask.roleHint;
    try {
      const route = await routeSubtask(jev, { subtask, brief, signal: runSignal });
      assignee = route.assignee;
      effort = route.effort;
      const routed = subtasks.get(subtask.id);
      if (routed) {
        subtasks.set(subtask.id, {
          ...routed,
          assignee: route.assignee,
          complexity: route.complexity,
          effort: route.effort,
        });
      }
      if (route.assignee !== "human" && route.assignee !== "none_needed") {
        role = route.assignee;
      }
      if (assignee !== "human") {
        const slot = await ensureSlot(role);
        emit({
          kind: "route.decided",
          role,
          subtaskId: subtask.id,
          agentId: slot.agentId,
          provenance: "jev",
          probabilities: [{ agentId: slot.agentId, probability: route.confidence }],
          confidence: route.confidence,
        });
      }
    } catch (err) {
      if (runSignal.aborted) throw new StopError();
      emit({
        kind: "route.skipped",
        role: subtask.roleHint,
        reason: `subtask routing failed (${errText(err)}); using the planner's role hint`,
      });
    }

    if (assignee === "human") {
      const slot = await ensureSlot(role);
      writeDegraded(subtask, role, slot.agentId, "requires a human decision; no agent acted");
      setStatus(subtask.id, "degraded");
      return;
    }

    const handler = roleHandlers[role];
    if (!handler) {
      throw new SubtaskFailure("permanent", `no handler is registered for the ${role} role`);
    }
    const slot = await ensureSlot(role);
    const criticSlot = await ensureSlot("critic");
    const producerLog = new AttemptLog();
    const criticLog = new AttemptLog();
    let unreviewed: string | null = null;
    let handoff: Handoff | undefined;

    for (;;) {
      const outcome = await produceWithReview({
        produce: (revision) =>
          supervised(
            slot,
            subtask,
            effort,
            ledger,
            producerLog,
            (deps) =>
              handler.produce(deps, {
                subtask,
                inputs: blackboard.getInputs(subtask.inputKeys, { allowMissing: true }),
                brief,
                ...(revision ? { revision } : {}),
              }),
            handoff,
          ),
        review: async (draft, attempt) => {
          if (handler.reviewed === false) return acceptedVerdict(subtask.id);
          try {
            const verdict = await supervised(
              criticSlot,
              subtask,
              "medium",
              ledger,
              criticLog,
              (deps) =>
                reviewDraft(
                  { ...deps, jev, blackboard, ledger, emit: (e) => emit(e as EventBody) },
                  {
                    subtask,
                    draft,
                    producer: { role: role as "researcher", agentId: slot.agentId },
                    attempt,
                  },
                ),
            );
            criticSlot.complete(subtask.id);
            return verdict;
          } catch (err) {
            if (err instanceof StopError) throw err;
            const detail = errText(err);
            // An exhausted critic slot was already traced by the supervisor.
            if (!(err instanceof SlotExhaustedError)) {
              criticSlot.fail(subtask.id, { kind: "failed", detail });
            }
            unreviewed = `unreviewed: the critic failed (${detail})`;
            return acceptedVerdict(subtask.id);
          }
        },
        commit: (draft) =>
          commitDraft(
            blackboard,
            subtask,
            { role, agentId: slot.agentId },
            unreviewed
              ? { ...draft, status: "degraded", degradedReason: draft.degradedReason ?? unreviewed }
              : draft,
          ),
      });

      if (outcome.status === "accepted") {
        slot.complete(subtask.id);
        setStatus(subtask.id, outcome.entry.status === "degraded" ? "degraded" : "completed");
        return;
      }
      slot.reject(subtask.id, outcome.rejections, outcome.findings);
      const request = outcome.findings.find((f) => f.requestedTask);
      const reason = `critic rejected the output ${outcome.rejections} times`;
      if (request?.requestedTask && rejectionReplans < (options.maxRejectionReplans ?? 1)) {
        rejectionReplans += 1;
        if (
          await tryReplan(
            subtask,
            `${reason}; requested task: ${request.requestedTask.title} - ${request.requestedTask.description}`,
          )
        ) {
          return;
        }
      }
      // Quality failure: the next standby, of an equal or higher tier, takes the subtask over.
      const takeover = await supervisor.takeover({
        slot,
        attemptAgentId: slot.agentId,
        subtask,
        reason: { kind: "rejected", detail: reason },
        alreadySignalled: true,
        lastBeatAt: slot.lastHeartbeatAt,
        detectedAt: now(),
        log: producerLog,
        inputs: blackboard.getInputs(subtask.inputKeys, { allowMissing: true }),
        criticFindings: outcome.findings,
        partialNotes: `Rejected draft: ${JSON.stringify(outcome.lastDraft.value) ?? "null"}`,
        effort,
      });
      if (!takeover) {
        await failSubtask(subtask, role, slot.agentId, `${reason}; no replacement is left`, true);
        return;
      }
      handoff = takeover.handoff;
      effort = takeover.effort ?? effort;
    }
  };

  /** Permanent failure: one replan if anything depends on it, otherwise a degraded entry. */
  const failSubtask = async (
    subtask: Subtask,
    role: SlotRole,
    agentId: string,
    reason: string,
    mayReplan: boolean,
  ): Promise<void> => {
    if (
      mayReplan &&
      failureReplans < (options.maxFailureReplans ?? 1) &&
      dependents(subtask.id).length > 0
    ) {
      failureReplans += 1;
      if (await tryReplan(subtask, reason)) return;
    }
    writeDegraded(subtask, role, agentId, reason);
    setStatus(subtask.id, "failed");
  };

  const runGuarded = async (subtask: Subtask): Promise<void> => {
    try {
      await runSubtask(subtask);
    } catch (err) {
      if (err instanceof StopError || runSignal.aborted) {
        setStatus(subtask.id, "failed");
        return;
      }
      const role = subtask.roleHint;
      const slot = slots.get(role);
      const failure = err instanceof SubtaskFailure ? err : await classifyFailure(err);
      // An exhausted slot was already failed and traced by the supervisor.
      if (!(failure instanceof SlotExhaustedError)) {
        slot?.fail(subtask.id, { kind: "failed", detail: failure.message }, failure.failureClass);
      }
      const agentId = slot?.agentId ?? "engine";
      if (failure.failureClass === "not_found") {
        writeDegraded(subtask, role, agentId, failure.message);
        setStatus(subtask.id, "degraded");
      } else {
        try {
          await failSubtask(subtask, role, agentId, failure.message, true);
        } catch {
          setStatus(subtask.id, "failed");
        }
      }
    } finally {
      emitBudget();
    }
  };

  const running = new Map<string, Promise<void>>();
  while (!runSignal.aborted) {
    const ready = [...subtasks.values()].filter(
      (s) =>
        s.status === "pending" &&
        !running.has(s.id) &&
        s.dependsOn.every((d) => SETTLED.includes(subtasks.get(d)?.status ?? "pending")),
    );
    for (const s of ready) {
      if (running.size >= (options.maxConcurrency ?? 4)) break;
      setStatus(s.id, "running");
      running.set(
        s.id,
        runGuarded(s).finally(() => running.delete(s.id)),
      );
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  await Promise.allSettled(running.values());

  if (runSignal.aborted) return wrapUpAndFinish();

  const all = [...subtasks.values()];
  const executorSubtasks = all.filter(
    (s) => s.roleHint === "executor" && blackboard.has(s.output.key),
  );
  const report = executorSubtasks.length
    ? blackboard.get(executorSubtasks[executorSubtasks.length - 1]!.output.key)
    : undefined;
  const degraded = all.filter((s) => s.status !== "completed");
  const unfinished = all.filter((s) => !SETTLED.includes(s.status));
  if (unfinished.length > 0) {
    return finish(
      "degraded",
      `${unfinished.length} subtask(s) could not run: ${unfinished.map((s) => s.id).join(", ")}`,
      report,
    );
  }
  return finish(
    degraded.length === 0 ? "completed" : "degraded",
    degraded.length === 0
      ? `all ${all.length} subtasks completed`
      : `finished with degraded results: ${degraded.map((s) => `${s.id} (${s.status})`).join(", ")}`,
    report,
  );

  // -- wrap-up -------------------------------------------------------------
  /** Budget cap or operator stop: one executor turn on the reserved slice writes the best report. */
  async function wrapUpAndFinish(): Promise<RunResult> {
    const reason = stoppedBy ?? "stopped";
    const status: RunStatus = reason === "operator" ? "aborted" : "degraded";
    const summary = `stopped by ${reason}`;
    if (!meter.startWrapUp()) {
      return finish(status, `${summary}; no budget was left for a wrap-up report`);
    }
    const key = blackboard.has("final_report") ? "final_report_wrapup" : "final_report";
    const wrapTask: Subtask = {
      id: "wrap-up",
      title: "Wrap-up report",
      description: `The run stopped early (${reason}). Write the best remediation report the blackboard supports. Everything not gathered belongs in "unknowns"; do not guess.`,
      dependsOn: [],
      roleHint: "executor",
      output: { key, schema: REMEDIATION_REPORT_SCHEMA },
      inputKeys: Object.keys(blackboard.getAll()),
      status: "running",
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.wrapUpTimeoutMs ?? 60_000);
    timer.unref();
    let entry: BlackboardEntry | undefined;
    try {
      const slot = await ensureSlot("executor");
      slot.start("wrap-up", "low");
      meter.recordStep();
      const deps = buildDeps(slot, "wrap-up", "low", new ToolLedger(), controller.signal);
      const draft = await raceAbort(
        runExecutor(deps, { subtask: wrapTask, inputs: blackboard.getAll(), brief }),
        controller.signal,
      );
      entry = commitDraft(
        blackboard,
        wrapTask,
        { role: "executor", agentId: slot.agentId },
        {
          ...draft,
          status: "degraded",
          degradedReason:
            draft.degradedReason ?? `run stopped early (${reason}); report is partial`,
        },
      );
      slot.complete("wrap-up");
    } catch (err) {
      controller.abort();
      slots.get("executor")?.fail("wrap-up", { kind: "failed", detail: errText(err) });
      // The wrap-up agent failed; the engine writes the report from what the blackboard holds.
      const held = Object.values(blackboard.getAll());
      entry = blackboard.writeDegraded({
        key,
        value: {
          summary: `Run stopped early (${reason}); the wrap-up agent failed: ${errText(err)}`,
          items: [],
          unknowns: [
            ...held.map((e) => `${e.key}: ${e.status}`),
            "everything not on the blackboard was not gathered",
          ],
        },
        evidence: [],
        writtenBy: { role: "executor", agentId: "engine" },
      });
    } finally {
      clearTimeout(timer);
    }
    return finish(status, `${summary}; wrap-up report written`, entry);
  }
}
