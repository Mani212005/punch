export interface ApprovalRequest {
  approvalId: string;
  tool: string;
  payload: unknown;
  subtaskId?: string;
  agentId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalGate {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Automatically approves all requests. Useful for tests and non-interactive workflows with explicit consent.
 */
export class AutoApprovalGate implements ApprovalGate {
  constructor(private readonly decidedBy: string = "auto") {}

  async requestApproval(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      approved: true,
      decidedBy: this.decidedBy,
    };
  }
}

/**
 * Automatically denies all requests. Used in unattended mode (--unattended).
 */
export class DenyAllApprovalGate implements ApprovalGate {
  constructor(private readonly reason: string = "unattended mode auto-denial") {}

  async requestApproval(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      approved: false,
      reason: this.reason,
      decidedBy: "system:unattended",
    };
  }
}

/**
 * Callback-driven approval gate for plugging in CLI prompts or WebSocket/SSE handlers.
 */
export class CallbackApprovalGate implements ApprovalGate {
  constructor(
    private readonly callback: (
      request: ApprovalRequest,
    ) => Promise<ApprovalDecision> | ApprovalDecision,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.callback(request);
  }
}

export interface RunApprovalOptions {
  /** `--unattended`: nothing irreversible is ever approved, whatever hook is attached. */
  unattended?: boolean;
  /** The interactive approve/deny hook (the CLI in A10, the console later). */
  gate?: ApprovalGate;
}

/**
 * The gate the run loop hands to the tool layer. There is no auto-approve: without an attached
 * approver an irreversible request is denied, so a run never acts without a human decision.
 */
export function selectApprovalGate(options: RunApprovalOptions = {}): ApprovalGate {
  if (options.unattended) return new DenyAllApprovalGate();
  return options.gate ?? new DenyAllApprovalGate("no approver is attached to this run");
}
