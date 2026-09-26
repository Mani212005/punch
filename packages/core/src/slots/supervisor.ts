import type {
  AgentEntry,
  Config,
  Effort,
  ErrorClass,
  FailureReason,
  Finding,
  Handoff,
  Provider,
  SlotRole,
  Subtask,
} from "@punch/shared";
import { ProviderHealth, selectReplacement, type Replacement } from "../router/standby.js";
import type { EmitEvent, Slot } from "../run/slot.js";
import {
  buildHandoff,
  summarizeHandoff,
  type AttemptLog,
} from "./handoff.js";
import { isCliKind, isProviderLevelFailure } from "./replacement.js";

/** Why an attempt was ended from outside: silence, the wall-clock cap, or the operator. */
export interface AttemptCause {
  kind: "stalled" | "timeout" | "operator_kill";
  detail: string;
  /** Time the supervisor detected it. */
  at: number;
}

/** The abort reason of an attempt the supervisor ended. */
export class AttemptAborted extends Error {
  readonly attempt: AttemptCause;
  constructor(cause: AttemptCause) {
    super(cause.detail);
    this.attempt = cause;
    this.name = "AttemptAborted";
  }
}

export interface SupervisorOptions {
  config: Config;
  emit: EmitEvent;
  now?: () => number;
  health?: ProviderHealth;
  /** Agent in the executor slot, for `distinctCritic`. */
  executorAgentId?: () => string | undefined;
  /** Fresh Jev routing for the role with these agents excluded (plan.md 2.3). */
  freshRouting?: (
    role: SlotRole,
    excludeAgentIds: string[],
  ) => Promise<{ agentId: string; probability?: number } | null>;
  /** Remaining steps, USD and wall-clock for the handoff. */
  budget: () => Handoff["budget"];
  /** Wall-clock cap per attempt; default 5 minutes. */
  attemptTimeoutMs?: number;
  /** How long a nudged agent gets to show a sign of life before it is declared stalled. */
  nudgeGraceMs?: number;
  /** Stall check period; default derived from the stall threshold. */
  checkIntervalMs?: number;
}

/** A running attempt under watch. */
export interface AttemptWatch {
  /** Aborts when the supervisor ends the attempt; compose with the run signal. */
  readonly signal: AbortSignal;
  /** An event arrived from the agent. */
  beat(): void;
  /** Why the supervisor ended the attempt, if it did. */
  cause(): AttemptCause | null;
  /** Time of the agent's latest event, for the detection gap in the trace. */
  lastBeatAt(): number;
  stop(): void;
}

export interface WatchOptions {
  subtaskId: string | undefined;
  /** Sends the one follow-up turn API agents get before a stall or timeout is final. */
  nudge?: () => void;
}

export interface TakeoverRequest {
  slot: Slot;
  /** Agent that was working when the failure was detected. */
  attemptAgentId: string;
  subtask: Subtask;
  reason: FailureReason;
  classification?: ErrorClass | undefined;
  /** Raw error text, used to decide whether the whole provider is unavailable. */
  errorText?: string;
  /** `slot.rejected` was already emitted by the caller, so `slot.failed` is not. */
  alreadySignalled?: boolean;
  lastBeatAt: number;
  detectedAt: number;
  log: AttemptLog;
  inputs: Handoff["inputs"];
  criticFindings?: Finding[] | null;
  partialNotes?: string | null;
  effort?: Effort | undefined;
}

export interface Takeover {
  agentId: string;
  effort?: Effort | undefined;
  handoff: Handoff;
  /** Another attempt on this slot had already replaced the agent; nothing new was traced. */
  adopted: boolean;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000;

/**
 * The slot supervisor (plan.md 2, A9). It watches running attempts for silence, the wall-clock
 * cap and operator kills, and it runs the takeover: fail the slot, select a replacement (pin,
 * chain, standby, fresh), build the handoff, trace `slot.replacing` and `slot.replaced`, and
 * install the new agent, or trace `slot.exhausted` when nothing eligible is left. The run loop
 * owns dispatch and calls in; the supervisor never runs an agent itself.
 */
export class SlotSupervisor {
  readonly health: ProviderHealth;
  private readonly now: () => number;
  private readonly agents: Map<string, AgentEntry>;
  private readonly providers: Map<string, Provider>;
  private readonly attempts = new Map<SlotRole, Set<{ trip: (cause: AttemptCause) => void }>>();
  private readonly inflight = new Map<SlotRole, Promise<unknown>>();

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.health = options.health ?? new ProviderHealth();
    this.agents = new Map(options.config.agents.map((a) => [a.id, a]));
    this.providers = new Map(options.config.providers.map((p) => [p.id, p]));
  }

  providerOf(agentId: string): Provider | undefined {
    const agent = this.agents.get(agentId);
    return agent ? this.providers.get(agent.providerId) : undefined;
  }

  /** Silence threshold for the agent, plan.md 2.1: API agents and CLI agents differ. */
  stallAfterMs(agentId: string): number {
    const { api, cli } = this.options.config.policy.stallAfterMs;
    return isCliKind(this.providerOf(agentId)?.kind) ? cli : api;
  }

  /** True when the agent's provider recently failed with an authentication or availability error. */
  providerDown(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    return agent ? this.health.isDown(agent.providerId, this.now()) : false;
  }


  // -- detection ---------------------------------------------------------

  /**
   * Starts watching an attempt. The returned signal aborts (with an `AttemptAborted`) on a stall
   * that survives the nudge, on the per-attempt cap, or on an operator kill.
   */
  watch(slot: Slot, options: WatchOptions): AttemptWatch {
    const controller = new AbortController();
    const startedAt = this.now();
    const stallAfter = this.stallAfterMs(slot.agentId);
    const cli = isCliKind(this.providerOf(slot.agentId)?.kind);
    const timeoutMs = this.options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    const grace = this.options.nudgeGraceMs ?? Math.min(10_000, Math.max(1, stallAfter / 2));
    const interval =
      this.options.checkIntervalMs ?? Math.max(5, Math.min(1000, Math.floor(stallAfter / 10)));
    let lastBeatAt = startedAt;
    let tripped: AttemptCause | null = null;
    let stalledAt: number | null = null;
    let timeoutNudgedAt: number | null = null;

    const trip = (cause: AttemptCause): void => {
      if (tripped) return;
      tripped = cause;
      if (timer) clearInterval(timer);
      controller.abort(new AttemptAborted(cause));
    };

    const check = (): void => {
      if (tripped) return;
      const now = this.now();
      const silent = now - lastBeatAt;
      if (stalledAt !== null) {
        if (lastBeatAt > stalledAt) {
          // A sign of life after the nudge: back to running.
          stalledAt = null;
          if (slot.state === "stalled") slot.transition("running");
        } else if (cli || now - stalledAt >= grace) {
          trip({
            kind: "stalled",
            detail: `no events for ${silent}ms (limit ${stallAfter}ms)${cli ? "" : ", nudge unanswered"}`,
            at: now,
          });
          return;
        }
      } else if (silent >= stallAfter) {
        stalledAt = now;
        if (slot.state === "running") slot.transition("stalled");
        this.options.emit({
          kind: "slot.stalled",
          role: slot.role,
          agentId: slot.agentId,
          ...(options.subtaskId !== undefined ? { subtaskId: options.subtaskId } : {}),
          silentMs: silent,
          nudged: !cli,
        });
        if (!cli) options.nudge?.();
        else {
          trip({
            kind: "stalled",
            detail: `no events for ${silent}ms (limit ${stallAfter}ms); CLI agents are not nudged`,
            at: now,
          });
          return;
        }
      }
      if (now - startedAt >= timeoutMs) {
        if (timeoutNudgedAt === null && !cli) {
          timeoutNudgedAt = now;
          options.nudge?.();
        } else if (cli || now - timeoutNudgedAt! >= grace) {
          trip({
            kind: "timeout",
            detail: `no result after ${now - startedAt}ms (cap ${timeoutMs}ms) although the agent was still emitting events`,
            at: now,
          });
        }
      }
    };

    const timer: ReturnType<typeof setInterval> | undefined = setInterval(check, interval);
    timer.unref();

    const entry = { trip };
    let set = this.attempts.get(slot.role);
    if (!set) this.attempts.set(slot.role, (set = new Set()));
    set.add(entry);

    return {
      signal: controller.signal,
      beat: () => {
        lastBeatAt = this.now();
      },
      cause: () => tripped,
      lastBeatAt: () => lastBeatAt,
      stop: () => {
        clearInterval(timer);
        this.attempts.get(slot.role)?.delete(entry);
      },
    };
  }

  /** Operator kill: ends every running attempt on the slot. False when nothing is running. */
  kill(role: SlotRole, detail = "killed by the operator"): boolean {
    const running = [...(this.attempts.get(role) ?? [])];
    for (const attempt of running) {
      attempt.trip({ kind: "operator_kill", detail, at: this.now() });
    }
    return running.length > 0;
  }

  // -- takeover ----------------------------------------------------------

  /**
   * Replaces the agent in the slot and returns the handoff for the replacement, or null when the
   * slot is exhausted (`slot.exhausted` traced, the slot ends `degraded`). A second attempt on
   * the same slot that fails behind the first one adopts the replacement instead of replacing
   * again.
   */
  async takeover(request: TakeoverRequest): Promise<Takeover | null> {
    const { slot } = request;
    const pending = this.inflight.get(slot.role);
    if (pending) await pending.catch(() => undefined);
    if (slot.agentId !== request.attemptAgentId) {
      return {
        agentId: slot.agentId,
        effort: slot.assignment.effort,
        adopted: true,
        handoff: this.handoffFor(request),
      };
    }
    const work = this.replace(request);
    this.inflight.set(slot.role, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(slot.role) === work) this.inflight.delete(slot.role);
    }
  }

  private handoffFor(request: TakeoverRequest): Handoff {
    const { slot } = request;
    const failed = this.agents.get(request.attemptAgentId);
    return buildHandoff({
      subtask: request.subtask,
      reason: request.reason,
      predecessor: {
        agentId: request.attemptAgentId,
        displayName: failed?.displayName ?? request.attemptAgentId,
        turnsUsed: slot.turnsUsed,
        usdUsed: slot.usdUsed,
      },
      inputs: request.inputs,
      log: request.log,
      ...(request.partialNotes !== undefined ? { partialNotes: request.partialNotes } : {}),
      criticFindings: request.criticFindings ?? null,
      budget: this.options.budget(),
      now: this.now(),
    });
  }

  private async replace(request: TakeoverRequest): Promise<Takeover | null> {
    const { slot, subtask, reason } = request;
    const { config } = this.options;
    const subtaskId = request.subtask.id === "plan" ? undefined : subtask.id;

    if (!request.alreadySignalled) slot.fail(subtaskId, reason, request.classification);
    if (request.errorText && isProviderLevelFailure(request.errorText)) {
      const providerId = this.agents.get(request.attemptAgentId)?.providerId;
      if (providerId) this.health.markDown(providerId, this.now());
    }
    const providerLevel =
      request.errorText !== undefined && isProviderLevelFailure(request.errorText);

    const exhaust = (why: string): null => {
      slot.transition("replacing");
      slot.transition("exhausted");
      this.options.emit({
        kind: "slot.exhausted",
        role: slot.role,
        ...(subtaskId !== undefined ? { subtaskId } : {}),
        reason: why,
        degradedKey: subtask.output.key,
      });
      slot.transition("degraded");
      return null;
    };

    if (slot.replaced.length >= config.policy.maxReplacementsPerSlot) {
      return exhaust(
        `${slot.replaced.length} replacements used (maxReplacementsPerSlot ${config.policy.maxReplacementsPerSlot}); last failure: ${reason.detail}`,
      );
    }

    const replacement: Replacement | null = await selectReplacement({
      role: slot.role,
      failedAgentId: request.attemptAgentId,
      reason,
      config,
      standby: slot.standby,
      triedAgentIds: [...slot.replaced.map((r) => r.agentId), request.attemptAgentId],
      providerHealth: this.health,
      now: this.now(),
      providerLevelFailure: providerLevel,
      ...(this.options.executorAgentId?.()
        ? { executorAgentId: this.options.executorAgentId() as string }
        : {}),
      ...(request.effort ?? slot.assignment.effort
        ? { failedEffort: (request.effort ?? slot.assignment.effort) as Effort }
        : {}),
      supportsEffort: (agent) => !isCliKind(this.providerOf(agent.id)?.kind),
      ...(this.options.freshRouting
        ? {
            freshRouting: (exclude: string[]) => this.options.freshRouting!(slot.role, exclude),
          }
        : {}),
    });
    if (!replacement) {
      return exhaust(`no eligible replacement remains; last failure: ${reason.detail}`);
    }

    const handoff = this.handoffFor(request);
    this.options.emit({
      kind: "slot.replacing",
      role: slot.role,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
      failedAgentId: request.attemptAgentId,
      replacementAgentId: replacement.agentId,
      reason,
      handoff: summarizeHandoff(handoff),
      selection: replacement.selection,
      detectionMs: Math.max(0, request.detectedAt - request.lastBeatAt),
    });
    slot.replaceAgent(
      {
        agentId: replacement.agentId,
        provenance: replacement.selection.provenance,
        ...(replacement.effort ? { effort: replacement.effort } : {}),
      },
      reason,
    );
    this.options.emit({
      kind: "slot.replaced",
      role: slot.role,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
      failedAgentId: request.attemptAgentId,
      replacementAgentId: replacement.agentId,
      takeoverMs: Math.max(0, this.now() - request.detectedAt),
    });
    return {
      agentId: replacement.agentId,
      effort: replacement.effort,
      handoff,
      adopted: false,
    };
  }
}
