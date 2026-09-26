import type {
  Effort,
  FailureReason,
  Provenance,
  SlotRole,
  SlotState,
  StandbyEntry,
  TraceEvent,
} from "@punch/shared";

/** A trace event before the writer stamps `runId`, `seq` and `ts`. */
export type EventBody = TraceEvent extends infer E
  ? E extends TraceEvent
    ? Omit<E, "runId" | "seq" | "ts">
    : never
  : never;

export type EmitEvent = (body: EventBody) => void;

/** Who fills the slot right now and how they were chosen. */
export interface SlotAgent {
  agentId: string;
  provenance: Provenance;
  /** Effort of the current attempt; the supervisor bumps it on replacement (plan.md 2.3). */
  effort?: Effort;
}

/** An agent that used to fill the slot; the "replaced" stack under the card (plan.md 2.5). */
export interface ReplacedAgent {
  agentId: string;
  reason: FailureReason;
  turnsUsed: number;
  usdUsed: number;
  replacedAt: number;
}

/**
 * plan.md 2.1. A slot that finished (or failed) one subtask may start the next one, so the
 * terminal-looking states still lead back to `running`; `replacing` is only entered by the
 * supervisor (A9), and `degraded` is the end of the replacement line.
 */
const TRANSITIONS: Record<SlotState, readonly SlotState[]> = {
  assigned: ["running", "replacing"],
  running: ["completed", "stalled", "failed", "rejected"],
  completed: ["running"],
  stalled: ["running", "failed", "replacing"],
  failed: ["running", "replacing"],
  rejected: ["running", "replacing"],
  replacing: ["running", "exhausted"],
  exhausted: ["degraded"],
  // A degraded slot is never replaced again, but its last agent may still take other subtasks.
  degraded: ["running"],
};

export class SlotTransitionError extends Error {
  constructor(
    readonly role: SlotRole,
    readonly from: SlotState,
    readonly to: SlotState,
  ) {
    super(`slot ${role}: illegal transition ${from} -> ${to}`);
    this.name = "SlotTransitionError";
  }
}

export interface SlotOptions {
  role: SlotRole;
  agentId: string;
  provenance: Provenance;
  /** Every other eligible agent, most probable first, from the router. */
  standby: StandbyEntry[];
  emit: EmitEvent;
  now?: () => number;
  /** `agent.heartbeat` trace events are sampled to at most one per this many ms. */
  heartbeatSampleMs?: number;
}

/**
 * A role slot as a first-class object (plan.md 2.1): it owns the current assignment, the standby
 * list, the state machine, the heartbeat timestamp and the stack of replaced agents. The run loop
 * drives it; the slot supervisor (A9) reads `lastHeartbeatAt`, watches `state`, and calls
 * `replaceAgent` on takeover. Several subtasks may run on one slot at once (`active`), so the
 * state is `running` while any of them is.
 */
export class Slot {
  readonly role: SlotRole;
  readonly standby: StandbyEntry[];
  readonly replaced: ReplacedAgent[] = [];
  /** Subtasks currently being worked on by this slot's agent. */
  readonly active = new Set<string>();

  private _state: SlotState = "assigned";
  private _assignment: SlotAgent;
  private _lastHeartbeatAt: number;
  private lastHeartbeatEventAt = Number.NEGATIVE_INFINITY;
  private _attempt = 0;
  private _turnsUsed = 0;
  private _usdUsed = 0;
  private readonly emit: EmitEvent;
  private readonly now: () => number;
  private readonly heartbeatSampleMs: number;

  constructor(options: SlotOptions) {
    this.role = options.role;
    this.standby = options.standby;
    this._assignment = { agentId: options.agentId, provenance: options.provenance };
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.heartbeatSampleMs = options.heartbeatSampleMs ?? 1000;
    this._lastHeartbeatAt = this.now();
  }

  get state(): SlotState {
    return this._state;
  }

  get assignment(): Readonly<SlotAgent> {
    return this._assignment;
  }

  get agentId(): string {
    return this._assignment.agentId;
  }

  /** Timestamp of the latest event from the agent in this slot; the supervisor's stall clock. */
  get lastHeartbeatAt(): number {
    return this._lastHeartbeatAt;
  }

  /** Agent starts (attempts) so far, across all subtasks and replacements. */
  get attempt(): number {
    return this._attempt;
  }

  get turnsUsed(): number {
    return this._turnsUsed;
  }

  get usdUsed(): number {
    return this._usdUsed;
  }

  /** Announces the initial assignment: routing chose an agent and a ranked standby list. */
  announce(): void {
    this.emit({
      kind: "slot.assigned",
      role: this.role,
      agentId: this.agentId,
      provenance: this._assignment.provenance,
      standby: this.standby,
    });
  }

  /** The agent begins work on a subtask (`agent.started`). Returns the attempt number. */
  start(subtaskId: string | undefined, effort?: Effort): number {
    this.transition("running");
    if (subtaskId !== undefined) this.active.add(subtaskId);
    this._attempt += 1;
    if (effort) this._assignment = { ...this._assignment, effort };
    this._lastHeartbeatAt = this.now();
    this.emit({
      kind: "agent.started",
      role: this.role,
      agentId: this.agentId,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
      attempt: this._attempt,
      ...(effort ? { effort } : {}),
    });
    return this._attempt;
  }

  /** Every event the agent yields is a heartbeat; the trace keeps a sample of them. */
  beat(subtaskId?: string): void {
    const ts = this.now();
    this._lastHeartbeatAt = ts;
    if (ts - this.lastHeartbeatEventAt < this.heartbeatSampleMs) return;
    this.lastHeartbeatEventAt = ts;
    this.emit({
      kind: "agent.heartbeat",
      role: this.role,
      agentId: this.agentId,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
    });
  }

  /** One model turn finished, with the USD it cost when metered. */
  noteTurn(usd = 0): void {
    this._turnsUsed += 1;
    this._usdUsed += usd;
  }

  /** The agent produced what the subtask needed. */
  complete(subtaskId: string | undefined): void {
    this.settle(subtaskId);
    if (this.active.size === 0 && this._state === "running") this.transition("completed");
  }

  /** The agent's work on the subtask ended in a terminal failure (`slot.failed`). */
  fail(
    subtaskId: string | undefined,
    reason: FailureReason,
    classification?: Extract<TraceEvent, { kind: "slot.failed" }>["classification"],
  ): void {
    this.settle(subtaskId);
    // A concurrent subtask may already have moved the slot off `running`; a stalled slot fails too.
    if (this._state === "running" || this._state === "stalled") this.transition("failed");
    this.emit({
      kind: "slot.failed",
      role: this.role,
      agentId: this.agentId,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
      reason,
      ...(classification ? { classification } : {}),
    });
  }

  /** The critic rejected this agent's output the maximum number of times (`slot.rejected`). */
  reject(
    subtaskId: string | undefined,
    rejections: number,
    findings: Extract<TraceEvent, { kind: "slot.rejected" }>["findings"],
  ): void {
    this.settle(subtaskId);
    if (this._state === "running") this.transition("rejected");
    this.emit({
      kind: "slot.rejected",
      role: this.role,
      agentId: this.agentId,
      ...(subtaskId !== undefined ? { subtaskId } : {}),
      rejections,
      findings,
    });
  }

  /**
   * Takeover hook for A9: the slot stays, the agent changes. Moves the current agent onto the
   * replaced stack and installs the replacement; the caller then `start`s it.
   */
  replaceAgent(next: SlotAgent, reason: FailureReason): void {
    if (this._state !== "replacing") this.transition("replacing");
    this.replaced.push({
      agentId: this.agentId,
      reason,
      turnsUsed: this._turnsUsed,
      usdUsed: this._usdUsed,
      replacedAt: this.now(),
    });
    this._assignment = next;
    this._turnsUsed = 0;
    this._usdUsed = 0;
  }

  /** Legal moves only; the supervisor and the loop share one state machine. */
  transition(to: SlotState): void {
    if (this._state === to) return;
    if (!TRANSITIONS[this._state].includes(to)) {
      throw new SlotTransitionError(this.role, this._state, to);
    }
    this._state = to;
  }

  private settle(subtaskId: string | undefined): void {
    if (subtaskId !== undefined) this.active.delete(subtaskId);
  }
}
