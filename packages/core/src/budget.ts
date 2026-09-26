import type { Budgets, Pricing, Usage } from "@punch/shared";
import { TraceEvent } from "@punch/shared";

export type BudgetExceededReason = "steps" | "usd" | "wallClock";

export interface BudgetMeterOptions {
  budgets: Budgets;
  pricingMap?: Record<string, Pricing> | ((agentId: string) => Pricing | undefined);
  now?: () => number;
  /** Reserved steps for the final wrap-up turn (default: 1). */
  wrapUpSteps?: number;
  onExceeded?: (reason: BudgetExceededReason) => void;
}

export interface BudgetStatus {
  steps: { used: number; max: number };
  usd: { used: number; max: number };
  ms: { used: number; max: number };
  exceeded: BudgetExceededReason | null;
  isExceeded: boolean;
  stepsRemaining: number;
  usdRemaining: number;
  msRemaining: number;
  wrapUpReserved: boolean;
  wrapUpActive: boolean;
}

export interface UsageCostResult {
  costUsd: number;
  metered: boolean;
  label: string;
}

export function calculateCost(usage: Usage, pricing?: Pricing): UsageCostResult {
  if (typeof usage.usd === "number") {
    return {
      costUsd: usage.usd,
      metered: true,
      label: `$${usage.usd.toFixed(4)}`,
    };
  }

  if (pricing) {
    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMTok;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMTok;
    const total = inputCost + outputCost;
    return {
      costUsd: total,
      metered: true,
      label: `$${total.toFixed(4)}`,
    };
  }

  return {
    costUsd: 0,
    metered: false,
    label: "cost not metered",
  };
}

export class BudgetMeter {
  readonly budgets: Budgets;
  private readonly pricingMap?:
    Record<string, Pricing> | ((agentId: string) => Pricing | undefined);
  private readonly now: () => number;
  private readonly wrapUpSteps: number;
  private readonly onExceededCallback?: (reason: BudgetExceededReason) => void;

  private _stepsUsed = 0;
  private _usdUsed = 0;
  private readonly startTime: number;
  private _isExceeded = false;
  private _exceededReason: BudgetExceededReason | null = null;
  private _wrapUpActive = false;
  private readonly controller = new AbortController();

  constructor(options: BudgetMeterOptions) {
    this.budgets = options.budgets;
    this.pricingMap = options.pricingMap;
    this.now = options.now ?? (() => Date.now());
    this.wrapUpSteps = options.wrapUpSteps ?? 1;
    this.onExceededCallback = options.onExceeded;
    this.startTime = this.now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stepsUsed(): number {
    return this._stepsUsed;
  }

  get usdUsed(): number {
    return this._usdUsed;
  }

  get msUsed(): number {
    return Math.max(0, this.now() - this.startTime);
  }

  get isExceeded(): boolean {
    return this._isExceeded;
  }

  get exceededReason(): BudgetExceededReason | null {
    return this._exceededReason;
  }

  get wrapUpActive(): boolean {
    return this._wrapUpActive;
  }

  /**
   * Checks if we have hit the reservation threshold for the wrap-up turn.
   */
  get isWrapUpReserved(): boolean {
    return this._stepsUsed >= this.budgets.maxSteps - this.wrapUpSteps;
  }

  /**
   * Whether a normal (non-wrapup) turn is allowed to execute.
   */
  canExecuteTurn(): boolean {
    if (this._isExceeded) return false;
    if (this._wrapUpActive) {
      return this._stepsUsed < this.budgets.maxSteps;
    }
    return !this.isWrapUpReserved;
  }

  /**
   * Activates the reserved wrap-up slice for the final executor turn.
   */
  startWrapUp(): boolean {
    if (this._stepsUsed >= this.budgets.maxSteps) {
      return false;
    }
    this._wrapUpActive = true;
    return true;
  }

  recordStep(count = 1): void {
    this._stepsUsed += count;
    this.evaluateBudgets();
  }

  recordUsage(agentId: string, usage: Usage, pricing?: Pricing): UsageCostResult {
    const resolvedPricing =
      pricing ??
      (typeof this.pricingMap === "function"
        ? this.pricingMap(agentId)
        : this.pricingMap?.[agentId]);

    const result = calculateCost(usage, resolvedPricing);
    this._usdUsed += result.costUsd;
    this.evaluateBudgets();
    return result;
  }

  private triggerExceeded(reason: BudgetExceededReason): void {
    if (this._isExceeded) return;
    this._isExceeded = true;
    this._exceededReason = reason;
    this.controller.abort(new Error(`Budget cap exceeded: ${reason}`));
    if (this.onExceededCallback) {
      try {
        this.onExceededCallback(reason);
      } catch (err) {
        console.error("BudgetMeter onExceeded callback error:", err);
      }
    }
  }

  private evaluateBudgets(): void {
    if (this._isExceeded) return;

    if (this._stepsUsed >= this.budgets.maxSteps) {
      this.triggerExceeded("steps");
      return;
    }

    if (this._usdUsed >= this.budgets.maxUsd) {
      this.triggerExceeded("usd");
      return;
    }

    if (this.msUsed >= this.budgets.maxWallClockMs) {
      this.triggerExceeded("wallClock");
      return;
    }
  }

  check(): BudgetStatus {
    this.evaluateBudgets();

    const stepsRemaining = Math.max(0, this.budgets.maxSteps - this._stepsUsed);
    const usdRemaining = Math.max(0, Number((this.budgets.maxUsd - this._usdUsed).toFixed(6)));
    const msRemaining = Math.max(0, this.budgets.maxWallClockMs - this.msUsed);

    return {
      steps: { used: this._stepsUsed, max: this.budgets.maxSteps },
      usd: { used: this._usdUsed, max: this.budgets.maxUsd },
      ms: { used: this.msUsed, max: this.budgets.maxWallClockMs },
      exceeded: this._exceededReason,
      isExceeded: this._isExceeded,
      stepsRemaining,
      usdRemaining,
      msRemaining,
      wrapUpReserved: this.isWrapUpReserved,
      wrapUpActive: this._wrapUpActive,
    };
  }

  getBudgetCheckedPayload(): {
    steps: { used: number; max: number };
    usd: { used: number; max: number };
    ms: { used: number; max: number };
    exceeded: BudgetExceededReason | null;
  } {
    const status = this.check();
    return {
      steps: status.steps,
      usd: status.usd,
      ms: status.ms,
      exceeded: status.exceeded,
    };
  }

  createBudgetCheckedEvent(base: { runId: string; seq?: number; ts?: number }): TraceEvent {
    const payload = this.getBudgetCheckedPayload();
    return TraceEvent.parse({
      runId: base.runId,
      seq: base.seq ?? 0,
      ts: base.ts ?? this.now(),
      kind: "budget.checked",
      ...payload,
    });
  }

  getRemaining(): { stepsRemaining: number; usdRemaining: number; msRemaining: number } {
    const status = this.check();
    return {
      stepsRemaining: status.stepsRemaining,
      usdRemaining: status.usdRemaining,
      msRemaining: status.msRemaining,
    };
  }

  abort(reason = "manual abort"): void {
    this.controller.abort(new Error(reason));
  }
}
