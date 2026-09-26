import type { SlotRole, TraceEvent } from "@punch/shared";
import type {
  ApprovalItem,
  BoardBudgetState,
  BoardRunState,
  BoardState,
  CriticVerdictItem,
  LogEntry,
  PlanGraphState,
  ReplacedAgent,
  RoleRoutingState,
  SlotLaneState,
  TakeoverBannerState,
  TimelineMarker,
  TimelineSpan,
} from "./types";

const DEFAULT_SLOT_ROLES: SlotRole[] = ["planner", "researcher", "executor", "critic"];

function createInitialSlotLane(role: SlotRole): SlotLaneState {
  return {
    role,
    state: "assigned",
    turns: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    standby: [],
    replaced: [],
    rejections: 0,
  };
}

export function createInitialBoardState(): BoardState {
  const slots: Record<SlotRole, SlotLaneState> = {
    planner: createInitialSlotLane("planner"),
    researcher: createInitialSlotLane("researcher"),
    executor: createInitialSlotLane("executor"),
    critic: createInitialSlotLane("critic"),
  };

  const run: BoardRunState = {
    runId: "",
    status: "pending",
    mode: "auto",
    chaos: [],
    isTakeoverInProgress: false,
  };

  const budget: BoardBudgetState = {
    steps: { used: 0, max: 0 },
    usd: { used: 0, max: 0 },
    ms: { used: 0, max: 0 },
    exceeded: null,
  };

  const plan: PlanGraphState = {
    subtasks: [],
  };

  const routing: Record<string, RoleRoutingState> = {};

  return {
    run,
    budget,
    slots,
    plan,
    routing,
    logs: {
      entries: [],
      byRole: {},
      byAgent: {},
    },
    takeover: {
      active: null,
      history: [],
    },
    approvals: [],
    criticVerdicts: [],
    blackboard: {},
    finalReport: null,
    replans: [],
    compensations: [],
    timeline: {
      spans: [],
      markers: [],
    },
    lastSeq: -1,
    eventCount: 0,
  };
}

function appendLogEntry(logs: BoardState["logs"], entry: LogEntry): BoardState["logs"] {
  const roleKey = entry.role ?? "system";
  const agentKey = entry.agentId ?? "system";

  const entries = [...logs.entries, entry];
  const byRole = {
    ...logs.byRole,
    [roleKey]: [...(logs.byRole[roleKey] ?? []), entry],
  };
  const byAgent = {
    ...logs.byAgent,
    [agentKey]: [...(logs.byAgent[agentKey] ?? []), entry],
  };

  return { entries, byRole, byAgent };
}

export function traceReducer(state: BoardState, event: TraceEvent): BoardState {
  const next: BoardState = {
    ...state,
    lastSeq: event.seq,
    eventCount: state.eventCount + 1,
    timeline: {
      ...state.timeline,
      startTs: state.timeline.startTs ?? event.ts,
      endTs: event.ts,
    },
  };

  switch (event.kind) {
    case "run.started": {
      const run: BoardRunState = {
        ...next.run,
        runId: event.runId,
        status: "running",
        repoUrl: event.task.repoUrl,
        brief: event.task.brief,
        budgetUsd: event.task.budgetUsd,
        mode: event.mode,
        orchestratorAgentId: event.orchestratorAgentId,
        chaos: event.chaos,
        startTime: event.ts,
        isTakeoverInProgress: false,
      };

      const budget: BoardBudgetState = {
        ...next.budget,
        steps: { used: 0, max: event.budgets.maxSteps },
        usd: { used: 0, max: event.budgets.maxUsd },
        ms: { used: 0, max: event.budgets.maxWallClockMs },
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: "orchestrator",
        agentId: event.orchestratorAgentId,
        kind: event.kind,
        type: "system",
        text: `Run ${event.runId} started in ${event.mode} mode for ${event.task.repoUrl}`,
      };

      return {
        ...next,
        run,
        budget,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "route.decided": {
      const routing: Record<string, RoleRoutingState> = {
        ...next.routing,
        [event.role]: {
          role: event.role,
          subtaskId: event.subtaskId,
          agentId: event.agentId,
          provenance: event.provenance,
          probabilities: event.probabilities,
          confidence: event.confidence,
          difficulty: event.difficulty,
          skipped: false,
        },
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "system",
        text: `Routed role "${event.role}" to ${event.agentId} (confidence: ${(event.confidence * 100).toFixed(0)}%, provenance: ${event.provenance})`,
      };

      return {
        ...next,
        routing,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "route.skipped": {
      const routing: Record<string, RoleRoutingState> = {
        ...next.routing,
        [event.role]: {
          role: event.role,
          probabilities: [],
          confidence: 0,
          skipped: true,
          skippedReason: event.reason,
        },
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        kind: event.kind,
        type: "system",
        text: `Routing skipped for role "${event.role}": ${event.reason}`,
      };

      return {
        ...next,
        routing,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "plan.created": {
      const plan: PlanGraphState = {
        subtasks: event.subtasks.map((st) => ({ ...st })),
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: "planner",
        kind: event.kind,
        type: "system",
        text: `Planner produced DAG with ${event.subtasks.length} subtasks`,
      };

      return {
        ...next,
        plan,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.assigned": {
      const prevSlot = next.slots[event.role] ?? createInitialSlotLane(event.role);
      const slot: SlotLaneState = {
        ...prevSlot,
        agentId: event.agentId,
        state: "assigned",
        provenance: event.provenance,
        standby: event.standby,
      };

      const slots = {
        ...next.slots,
        [event.role]: slot,
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" assigned to ${event.agentId} (${event.standby.length} standbys)`,
        slotInfo: { state: "assigned" },
      };

      return {
        ...next,
        slots,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "agent.started": {
      const role = event.role;
      const prevSlot = next.slots[role] ?? createInitialSlotLane(role);
      const slot: SlotLaneState = {
        ...prevSlot,
        agentId: event.agentId,
        state: "running",
        lastHeartbeatTs: event.ts,
        currentSubtaskId: event.subtaskId ?? prevSlot.currentSubtaskId,
      };

      const slots = {
        ...next.slots,
        [role]: slot,
      };

      // Update subtask status in plan if subtaskId provided
      let subtasks = next.plan.subtasks;
      if (event.subtaskId) {
        subtasks = next.plan.subtasks.map((st) =>
          st.id === event.subtaskId ? { ...st, status: "running" as const } : st,
        );
      }

      // Add timeline span
      const spans: TimelineSpan[] = [
        ...next.timeline.spans,
        {
          id: `span-agent-${event.role}-${event.agentId}-${event.subtaskId ?? "main"}-${event.attempt}`,
          role: event.role,
          agentId: event.agentId,
          subtaskId: event.subtaskId,
          type: "agent",
          label: `${event.agentId} · ${event.subtaskId ?? event.role}`,
          startTs: event.ts,
          status: "running",
        },
      ];

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "system",
        text: `Agent ${event.agentId} started subtask ${event.subtaskId ?? "main"} (attempt ${event.attempt}${event.effort ? `, effort: ${event.effort}` : ""})`,
      };

      return {
        ...next,
        slots,
        plan: { subtasks },
        timeline: { ...next.timeline, spans },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "agent.heartbeat": {
      const prevSlot = next.slots[event.role];
      if (!prevSlot) return next;

      const slot: SlotLaneState = {
        ...prevSlot,
        lastHeartbeatTs: event.ts,
        silentMs: undefined,
        nudged: undefined,
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
      };
    }

    case "agent.text": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            turns: prevSlot.turns + 1,
            lastHeartbeatTs: event.ts,
          }
        : createInitialSlotLane(event.role);

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "text",
        text: event.text,
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "agent.opaque_output": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            lastHeartbeatTs: event.ts,
          }
        : createInitialSlotLane(event.role);

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "opaque",
        text: event.text,
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "tool.called": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            lastHeartbeatTs: event.ts,
          }
        : createInitialSlotLane(event.role);

      const span: TimelineSpan = {
        id: `span-tool-${event.callId}`,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        type: "tool",
        label: `${event.tool}`,
        startTs: event.ts,
        status: "running",
        detail: JSON.stringify(event.input),
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "tool_call",
        toolCall: {
          callId: event.callId,
          tool: event.tool,
          input: event.input,
        },
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        timeline: {
          ...next.timeline,
          spans: [...next.timeline.spans, span],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "tool.result": {
      const spans = next.timeline.spans.map((span) => {
        if (span.id === `span-tool-${event.callId}`) {
          return {
            ...span,
            endTs: event.ts,
            status: event.ok
              ? event.cached
                ? ("cached" as const)
                : ("completed" as const)
              : ("failed" as const),
          };
        }
        return span;
      });

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "tool_result",
        toolResult: {
          callId: event.callId,
          tool: event.tool,
          ok: event.ok,
          cached: event.cached,
          latencyMs: event.latencyMs,
          retries: event.retries,
          output: event.output,
          error: event.error,
          errorClass: event.errorClass,
        },
      };

      return {
        ...next,
        timeline: { ...next.timeline, spans },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "tool.retry": {
      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "tool_retry",
        toolRetry: {
          callId: event.callId,
          tool: event.tool,
          attempt: event.attempt,
          delayMs: event.delayMs,
          errorClass: event.errorClass,
          error: event.error,
        },
      };

      return {
        ...next,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "fallback.used": {
      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "fallback",
        fallback: {
          tool: event.tool,
          from: event.from,
          to: event.to,
          reason: event.reason,
        },
      };

      return {
        ...next,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "blackboard.written": {
      const blackboard = {
        ...next.blackboard,
        [event.key]: event.entry,
      };

      // Mark matching subtask as completed
      const subtasks = next.plan.subtasks.map((st) => {
        if (st.output.key === event.key) {
          return { ...st, status: "completed" as const };
        }
        return st;
      });

      const role = (event.entry.writtenBy.role as SlotRole) ?? undefined;
      const agentId = event.entry.writtenBy.agentId;
      const subtaskId = event.entry.writtenBy.subtaskId;

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: role in next.slots ? role : undefined,
        agentId,
        subtaskId,
        kind: event.kind,
        type: "blackboard",
        blackboard: {
          key: event.key,
          entry: event.entry,
        },
      };

      return {
        ...next,
        blackboard,
        plan: { subtasks },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.stalled": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            state: "stalled",
            silentMs: event.silentMs,
            nudged: event.nudged,
          }
        : { ...createInitialSlotLane(event.role), state: "stalled" };

      const marker: TimelineMarker = {
        id: `marker-stall-${event.seq}`,
        ts: event.ts,
        type: "error",
        label: `${event.role} stalled (${event.silentMs}ms silence)`,
        color: "yellow",
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" stalled after ${event.silentMs}ms silence (nudged: ${event.nudged})`,
        slotInfo: { state: "stalled" },
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        timeline: {
          ...next.timeline,
          markers: [...next.timeline.markers, marker],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.failed": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            state: "failed",
            failureReason: event.reason,
            classification: event.classification,
          }
        : {
            ...createInitialSlotLane(event.role),
            state: "failed",
            failureReason: event.reason,
            classification: event.classification,
          };

      const marker: TimelineMarker = {
        id: `marker-fail-${event.seq}`,
        ts: event.ts,
        type: "kill",
        label: `${event.role} failed: ${event.reason.kind}`,
        color: "red",
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" failed: ${event.reason.kind} (${event.reason.detail})`,
        slotInfo: { state: "failed", detail: event.reason.detail },
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        timeline: {
          ...next.timeline,
          markers: [...next.timeline.markers, marker],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.rejected": {
      const prevSlot = next.slots[event.role];
      const slot: SlotLaneState = prevSlot
        ? {
            ...prevSlot,
            state: "rejected",
            rejections: event.rejections,
          }
        : {
            ...createInitialSlotLane(event.role),
            state: "rejected",
            rejections: event.rejections,
          };

      const marker: TimelineMarker = {
        id: `marker-reject-${event.seq}`,
        ts: event.ts,
        type: "error",
        label: `${event.role} rejected (rejection #${event.rejections})`,
        color: "red",
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" rejected by critic (${event.rejections} rejections, ${event.findings.length} findings)`,
        slotInfo: { state: "rejected" },
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        timeline: {
          ...next.timeline,
          markers: [...next.timeline.markers, marker],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.replacing": {
      const prevSlot = next.slots[event.role] ?? createInitialSlotLane(event.role);
      const slot: SlotLaneState = {
        ...prevSlot,
        state: "replacing",
      };

      const replacementsUsed = prevSlot.replaced.length + 1;
      const banner: TakeoverBannerState = {
        role: event.role,
        subtaskId: event.subtaskId,
        failedAgentId: event.failedAgentId,
        replacementAgentId: event.replacementAgentId,
        reason: event.reason,
        handoff: event.handoff,
        selection: event.selection,
        detectionMs: event.detectionMs,
        status: "replacing",
        ts: event.ts,
        replacementsUsed,
        maxReplacements: 2,
      };

      const marker: TimelineMarker = {
        id: `marker-replacing-${event.seq}`,
        ts: event.ts,
        type: "takeover",
        label: `Takeover -> ${event.replacementAgentId}`,
        color: "yellow",
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Takeover in progress for "${event.role}": ${event.failedAgentId} -> ${event.replacementAgentId} (${event.handoff.cachedResultCount} cached results)`,
        slotInfo: { state: "replacing" },
      };

      return {
        ...next,
        run: {
          ...next.run,
          isTakeoverInProgress: true,
        },
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        takeover: {
          active: banner,
          history: [...next.takeover.history, banner],
        },
        timeline: {
          ...next.timeline,
          markers: [...next.timeline.markers, marker],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.replaced": {
      const prevSlot = next.slots[event.role] ?? createInitialSlotLane(event.role);

      // Create replaced agent record for historical stack
      const replacedRecord: ReplacedAgent = {
        agentId: event.failedAgentId,
        role: event.role,
        reason: prevSlot.failureReason ?? { kind: "failed", detail: "unknown" },
        classification: prevSlot.classification,
        turns: prevSlot.turns,
        tokens: prevSlot.tokens,
        costUsd: prevSlot.costUsd,
        subtaskId: event.subtaskId,
        ts: event.ts,
      };

      // Filter replacement out of standby list
      const standby = prevSlot.standby.filter((s) => s.agentId !== event.replacementAgentId);

      const slot: SlotLaneState = {
        ...prevSlot,
        agentId: event.replacementAgentId,
        state: "running",
        standby,
        replaced: [...prevSlot.replaced, replacedRecord],
        failureReason: undefined,
        classification: undefined,
      };

      // Update takeover banner state
      let activeBanner = next.takeover.active;
      if (activeBanner) {
        activeBanner = {
          ...activeBanner,
          status: "replaced",
          takeoverMs: event.takeoverMs,
        };
      }

      const history = next.takeover.history.map((h) =>
        h.role === event.role && h.replacementAgentId === event.replacementAgentId
          ? { ...h, status: "replaced" as const, takeoverMs: event.takeoverMs }
          : h,
      );

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        agentId: event.replacementAgentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" replaced: ${event.replacementAgentId} active in ${event.takeoverMs}ms`,
        slotInfo: { state: "running" },
      };

      return {
        ...next,
        run: {
          ...next.run,
          isTakeoverInProgress: false,
        },
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        takeover: {
          active: activeBanner,
          history,
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "slot.exhausted": {
      const prevSlot = next.slots[event.role] ?? createInitialSlotLane(event.role);
      const slot: SlotLaneState = {
        ...prevSlot,
        state: "exhausted",
        exhaustedReason: event.reason,
        degradedKey: event.degradedKey,
      };

      // If subtaskId provided, mark subtask as degraded
      let subtasks = next.plan.subtasks;
      if (event.subtaskId) {
        subtasks = next.plan.subtasks.map((st) =>
          st.id === event.subtaskId ? { ...st, status: "degraded" as const } : st,
        );
      }

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "slot",
        text: `Slot "${event.role}" exhausted: ${event.reason}`,
        slotInfo: { state: "exhausted", detail: event.reason },
      };

      return {
        ...next,
        slots: {
          ...next.slots,
          [event.role]: slot,
        },
        plan: { subtasks },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "critic.verdict": {
      const verdictItem: CriticVerdictItem = {
        subtaskId: event.subtaskId,
        agentId: event.agentId,
        verdict: event.verdict,
        attempt: event.attempt,
        findings: event.findings,
        ts: event.ts,
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        role: "critic",
        agentId: event.agentId,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "critic",
        critic: {
          verdict: event.verdict,
          attempt: event.attempt,
          findings: event.findings,
        },
        text: `Critic verdict for ${event.subtaskId}: ${event.verdict} (attempt ${event.attempt}, ${event.findings.length} findings)`,
      };

      return {
        ...next,
        criticVerdicts: [...next.criticVerdicts, verdictItem],
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "approval.requested": {
      const approvalItem: ApprovalItem = {
        approvalId: event.approvalId,
        tool: event.tool,
        payload: event.payload,
        status: "pending",
        requestedTs: event.ts,
      };

      const marker: TimelineMarker = {
        id: `marker-approval-${event.approvalId}`,
        ts: event.ts,
        type: "approval",
        label: `Approval requested: ${event.tool}`,
        color: "yellow",
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "approval",
        approval: {
          approvalId: event.approvalId,
          status: "requested",
          tool: event.tool,
          payload: event.payload,
        },
        text: `Approval requested for irreversible tool ${event.tool} (id: ${event.approvalId})`,
      };

      return {
        ...next,
        approvals: [...next.approvals, approvalItem],
        timeline: {
          ...next.timeline,
          markers: [...next.timeline.markers, marker],
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "approval.granted": {
      const approvals = next.approvals.map((app) =>
        app.approvalId === event.approvalId
          ? {
              ...app,
              status: "granted" as const,
              decidedBy: event.decidedBy,
              decidedTs: event.ts,
            }
          : app,
      );

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "approval",
        approval: {
          approvalId: event.approvalId,
          status: "granted",
          decidedBy: event.decidedBy,
        },
        text: `Approval granted for ${event.approvalId} by ${event.decidedBy ?? "operator"}`,
      };

      return {
        ...next,
        approvals,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "approval.denied": {
      const approvals = next.approvals.map((app) =>
        app.approvalId === event.approvalId
          ? {
              ...app,
              status: "denied" as const,
              decidedBy: event.decidedBy,
              reason: event.reason,
              decidedTs: event.ts,
            }
          : app,
      );

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "approval",
        approval: {
          approvalId: event.approvalId,
          status: "denied",
          decidedBy: event.decidedBy,
          reason: event.reason,
        },
        text: `Approval denied for ${event.approvalId} by ${event.decidedBy ?? "operator"}${event.reason ? `: ${event.reason}` : ""}`,
      };

      return {
        ...next,
        approvals,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "budget.checked": {
      const budget: BoardBudgetState = {
        steps: event.steps,
        usd: event.usd,
        ms: event.ms,
        exceeded: event.exceeded,
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "budget",
        text: `Budget check: ${event.steps.used}/${event.steps.max} steps, $${event.usd.used.toFixed(2)}/$${event.usd.max.toFixed(2)}, ${(event.ms.used / 1000).toFixed(0)}s/${(event.ms.max / 1000).toFixed(0)}s${event.exceeded ? ` (EXCEEDED: ${event.exceeded})` : ""}`,
      };

      return {
        ...next,
        budget,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "replan.triggered": {
      const replans = [
        ...next.replans,
        {
          subtaskId: event.subtaskId,
          reason: event.reason,
          ts: event.ts,
        },
      ];

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        subtaskId: event.subtaskId,
        kind: event.kind,
        type: "replan",
        text: `Replan triggered on subtask ${event.subtaskId}: ${event.reason}`,
      };

      return {
        ...next,
        replans,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "compensation.ran": {
      const compensations = [
        ...next.compensations,
        {
          action: event.action,
          ok: event.ok,
          detail: event.detail,
          ts: event.ts,
        },
      ];

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "compensation",
        text: `Compensation "${event.action}": ${event.ok ? "succeeded" : "failed"}${event.detail ? ` (${event.detail})` : ""}`,
      };

      return {
        ...next,
        compensations,
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    case "run.finished": {
      const run: BoardRunState = {
        ...next.run,
        status: event.status,
        summary: event.summary,
        reportKey: event.reportKey,
        endTime: event.ts,
        isTakeoverInProgress: false,
      };

      // Mark all slots completed if run succeeded
      const slots: Record<SlotRole, SlotLaneState> = { ...next.slots };
      if (event.status === "completed") {
        for (const role of DEFAULT_SLOT_ROLES) {
          if (slots[role] && slots[role].state !== "failed" && slots[role].state !== "exhausted") {
            slots[role] = { ...slots[role], state: "completed" };
          }
        }
      }

      // Close open timeline spans
      const spans = next.timeline.spans.map((s) => ({
        ...s,
        endTs: s.endTs ?? event.ts,
        status: s.status === "running" ? ("completed" as const) : s.status,
      }));

      const marker: TimelineMarker = {
        id: `marker-finish-${event.seq}`,
        ts: event.ts,
        type: "finish",
        label: `Run finished: ${event.status}`,
        color: event.status === "completed" ? "blue" : "red",
      };

      const finalReport = {
        status: event.status,
        summary: event.summary,
        reportKey: event.reportKey,
      };

      const logEntry: LogEntry = {
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        type: "system",
        text: `Run finished with status "${event.status}"${event.summary ? `: ${event.summary}` : ""}`,
      };

      return {
        ...next,
        run,
        slots,
        finalReport,
        timeline: {
          ...next.timeline,
          spans,
          markers: [...next.timeline.markers, marker],
          endTs: event.ts,
        },
        logs: appendLogEntry(next.logs, logEntry),
      };
    }

    default: {
      return next;
    }
  }
}

export function reduceTrace(events: TraceEvent[]): BoardState {
  let state = createInitialBoardState();
  for (const event of events) {
    state = traceReducer(state, event);
  }
  return state;
}
