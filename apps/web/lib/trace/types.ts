import type {
  BlackboardEntry,
  Claim,
  ClaimActor,
  ClaimStatus,
  Difficulty,
  ErrorClass,
  EvidenceRecord,
  FailureReason,
  Finding,
  HandoffSummary,
  Plan,
  Provenance,
  Role,
  SandboxStepName,
  SandboxStepResult,
  SandboxValidation,
  SelectionProvenance,
  SlotRole,
  SlotState,
  StandbyEntry,
  Subtask,
  TraceEvent,
  TraceEventKind,
} from "@punch/shared";

export interface BoardRunState {
  runId: string;
  status: "pending" | "running" | "completed" | "degraded" | "aborted" | "failed";
  repoUrl?: string;
  brief?: string;
  budgetUsd?: number;
  mode: "auto" | "manual";
  orchestratorAgentId?: string;
  chaos: string[];
  startTime?: number;
  endTime?: number;
  summary?: string;
  reportKey?: string;
  isTakeoverInProgress: boolean;
}

export interface BoardBudgetState {
  steps: { used: number; max: number };
  usd: { used: number; max: number };
  ms: { used: number; max: number };
  exceeded: "steps" | "usd" | "wallClock" | null;
}

export interface ReplacedAgent {
  agentId: string;
  role: SlotRole;
  reason: FailureReason;
  classification?: ErrorClass;
  turns: number;
  tokens: { input: number; output: number };
  costUsd: number;
  subtaskId?: string;
  ts: number;
}

export interface SlotLaneState {
  role: SlotRole;
  agentId?: string;
  state: SlotState;
  provenance?: Provenance;
  turns: number;
  tokens: { input: number; output: number };
  costUsd: number;
  lastHeartbeatTs?: number;
  silentMs?: number;
  nudged?: boolean;
  currentSubtaskId?: string;
  standby: StandbyEntry[];
  replaced: ReplacedAgent[];
  rejections: number;
  failureReason?: FailureReason;
  classification?: ErrorClass;
  exhaustedReason?: string;
  degradedKey?: string;
}

export interface PlanGraphState {
  subtasks: Subtask[];
}

export interface RoleRoutingState {
  role: Role;
  subtaskId?: string;
  agentId?: string;
  provenance?: Provenance;
  probabilities: { agentId: string; probability: number }[];
  confidence: number;
  difficulty?: Difficulty;
  skipped?: boolean;
  skippedReason?: string;
}

export interface LogEntry {
  seq: number;
  ts: number;
  role?: Role | SlotRole;
  agentId?: string;
  subtaskId?: string;
  kind: TraceEventKind;
  type:
    | "text"
    | "opaque"
    | "tool_call"
    | "tool_result"
    | "tool_retry"
    | "fallback"
    | "blackboard"
    | "slot"
    | "critic"
    | "approval"
    | "budget"
    | "replan"
    | "compensation"
    | "claim"
    | "evidence"
    | "sandbox"
    | "remediation"
    | "system";
  text?: string;
  toolCall?: { callId: string; tool: string; input: unknown };
  toolResult?: {
    callId: string;
    tool: string;
    ok: boolean;
    cached: boolean;
    latencyMs: number;
    retries: number;
    output?: unknown;
    error?: string;
    errorClass?: ErrorClass;
  };
  toolRetry?: {
    callId: string;
    tool: string;
    attempt: number;
    delayMs: number;
    errorClass: ErrorClass;
    error: string;
  };
  fallback?: { tool: string; from: string; to: string; reason: string };
  blackboard?: { key: string; entry: BlackboardEntry };
  critic?: { verdict: "accepted" | "rejected"; attempt: number; findings: Finding[] };
  approval?: {
    approvalId: string;
    status: "requested" | "granted" | "denied";
    tool?: string;
    payload?: unknown;
    decidedBy?: string;
    reason?: string;
  };
  slotInfo?: {
    state: SlotState;
    detail?: string;
  };
  claimInfo?: {
    claimId: string;
    status: Claim["status"];
    verifier?: ClaimActor | null;
    rationale?: string;
  };
  evidenceInfo?: {
    evidenceId: string;
    kind: EvidenceRecord["kind"];
    ref: string;
  };
  sandboxInfo?: {
    findingId: string;
    phase?: "baseline" | "candidate";
    step?: SandboxStepName;
    verdict?: SandboxValidation["verdict"];
  };
  remediationInfo?: {
    findingId: string;
    action: "issue" | "pull_request";
  };
}

export interface TakeoverBannerState {
  role: SlotRole;
  subtaskId?: string;
  failedAgentId: string;
  replacementAgentId: string;
  reason: FailureReason;
  classification?: ErrorClass;
  handoff: HandoffSummary;
  selection: SelectionProvenance;
  detectionMs?: number;
  takeoverMs?: number;
  status: "replacing" | "replaced";
  ts: number;
  replacementsUsed: number;
  maxReplacements: number;
}

export interface ApprovalItem {
  approvalId: string;
  tool: string;
  payload: unknown;
  status: "pending" | "granted" | "denied";
  decidedBy?: string;
  reason?: string;
  requestedTs: number;
  decidedTs?: number;
}

export interface CriticVerdictItem {
  subtaskId: string;
  agentId: string;
  verdict: "accepted" | "rejected";
  attempt: number;
  findings: Finding[];
  ts: number;
}

export interface ClaimLedgerItem {
  claim: Claim;
  recordedTs: number;
  verifiedTs?: number;
  verifiedRationale?: string;
}

export interface EvidenceLedgerItem {
  evidence: EvidenceRecord;
  role: SlotRole | "validator";
  agentId?: string;
  subtaskId?: string;
  recordedTs: number;
}

export interface SandboxStepEntry {
  phase: "baseline" | "candidate";
  step: SandboxStepName;
  result: SandboxStepResult;
  ts: number;
}

export interface SandboxRunBoardState {
  findingId: string;
  dependency: string;
  from: string;
  to: string;
  isolation: "docker" | "host" | "none";
  startedTs: number;
  steps: SandboxStepEntry[];
  validation?: SandboxValidation;
  finishedTs?: number;
}

export interface RemediationProposal {
  findingId: string;
  action: "issue" | "pull_request";
  dependency: string;
  from: string;
  to: string | null;
  approvalId?: string;
  summary: string;
  ts: number;
}

export interface TimelineSpan {
  id: string;
  role: Role | SlotRole;
  agentId: string;
  subtaskId?: string;
  type: "agent" | "tool";
  label: string;
  startTs: number;
  endTs?: number;
  status: "running" | "completed" | "failed" | "cached";
  detail?: string;
}

export interface TimelineMarker {
  id: string;
  ts: number;
  type: "kill" | "takeover" | "error" | "approval" | "finish";
  label: string;
  color: "red" | "blue" | "yellow" | "ink";
}

export interface BoardState {
  run: BoardRunState;
  budget: BoardBudgetState;
  slots: Record<SlotRole, SlotLaneState>;
  plan: PlanGraphState;
  routing: Record<string, RoleRoutingState>;
  logs: {
    entries: LogEntry[];
    byRole: Record<string, LogEntry[]>;
    byAgent: Record<string, LogEntry[]>;
  };
  takeover: {
    active: TakeoverBannerState | null;
    history: TakeoverBannerState[];
  };
  approvals: ApprovalItem[];
  criticVerdicts: CriticVerdictItem[];
  claims: Record<string, ClaimLedgerItem>;
  evidence: Record<string, EvidenceLedgerItem>;
  sandbox: Record<string, SandboxRunBoardState>;
  remediations: RemediationProposal[];
  /** Roles that have appeared in this trace (slot.assigned, agent.*, evidence). Only these render slot cards. */
  seenRoles: SlotRole[];
  blackboard: Record<string, BlackboardEntry>;
  finalReport: {
    status: string;
    summary?: string;
    reportKey?: string;
  } | null;
  replans: { subtaskId: string; reason: string; ts: number }[];
  compensations: { action: string; ok: boolean; detail?: string; ts: number }[];
  timeline: {
    spans: TimelineSpan[];
    markers: TimelineMarker[];
    startTs?: number;
    endTs?: number;
  };
  lastSeq: number;
  eventCount: number;
}

export type {
  TraceEvent,
  TraceEventKind,
  SlotState,
  SlotRole,
  Role,
  Subtask,
  Plan,
  BlackboardEntry,
  Claim,
  ClaimActor,
  ClaimStatus,
  EvidenceRecord,
  SandboxStepName,
  SandboxStepResult,
  SandboxValidation,
  Finding,
  FailureReason,
  StandbyEntry,
  HandoffSummary,
  SelectionProvenance,
  ErrorClass,
  Provenance,
  Difficulty,
};
