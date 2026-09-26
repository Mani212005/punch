import { describe, expect, it, vi } from "vitest";
import { BudgetMeter, calculateCost } from "./budget.js";

describe("calculateCost", () => {
  it("uses usage.usd directly when present", () => {
    const res = calculateCost({ inputTokens: 100, outputTokens: 50, usd: 0.05 });
    expect(res.costUsd).toBe(0.05);
    expect(res.metered).toBe(true);
    expect(res.label).toBe("$0.0500");
  });

  it("calculates cost from token counts and pricing", () => {
    const pricing = { inputUsdPerMTok: 3.0, outputUsdPerMTok: 15.0 };
    const res = calculateCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, pricing);
    // (1 * 3.0) + (0.5 * 15.0) = 3.0 + 7.5 = 10.5
    expect(res.costUsd).toBeCloseTo(10.5);
    expect(res.metered).toBe(true);
    expect(res.label).toBe("$10.5000");
  });

  it("returns cost 0 and 'cost not metered' for CLI agents without pricing", () => {
    const res = calculateCost({ inputTokens: 100, outputTokens: 50 });
    expect(res.costUsd).toBe(0);
    expect(res.metered).toBe(false);
    expect(res.label).toBe("cost not metered");
  });
});

describe("BudgetMeter", () => {
  it("fires abort signal when maxSteps is reached", () => {
    const onExceeded = vi.fn();
    const meter = new BudgetMeter({
      budgets: { maxSteps: 3, maxUsd: 10.0, maxWallClockMs: 60_000 },
      onExceeded,
    });

    expect(meter.signal.aborted).toBe(false);
    expect(meter.isExceeded).toBe(false);

    meter.recordStep(1);
    expect(meter.stepsUsed).toBe(1);
    expect(meter.signal.aborted).toBe(false);

    meter.recordStep(1);
    expect(meter.stepsUsed).toBe(2);
    expect(meter.signal.aborted).toBe(false);

    meter.recordStep(1);
    expect(meter.stepsUsed).toBe(3);
    expect(meter.signal.aborted).toBe(true);
    expect(meter.isExceeded).toBe(true);
    expect(meter.exceededReason).toBe("steps");
    expect(onExceeded).toHaveBeenCalledWith("steps");
  });

  it("fires abort signal when maxUsd is reached", () => {
    const onExceeded = vi.fn();
    const pricingMap = {
      claude: { inputUsdPerMTok: 3.0, outputUsdPerMTok: 15.0 },
    };

    const meter = new BudgetMeter({
      budgets: { maxSteps: 100, maxUsd: 5.0, maxWallClockMs: 60_000 },
      pricingMap,
      onExceeded,
    });

    // 500,000 input tokens = $1.50
    meter.recordUsage("claude", { inputTokens: 500_000, outputTokens: 0 });
    expect(meter.usdUsed).toBeCloseTo(1.5);
    expect(meter.isExceeded).toBe(false);

    // Another 1,500,000 input tokens = $4.50 (total $6.00 > $5.00)
    meter.recordUsage("claude", { inputTokens: 1_500_000, outputTokens: 0 });
    expect(meter.usdUsed).toBeCloseTo(6.0);
    expect(meter.isExceeded).toBe(true);
    expect(meter.exceededReason).toBe("usd");
    expect(meter.signal.aborted).toBe(true);
    expect(onExceeded).toHaveBeenCalledWith("usd");
  });

  it("fires abort signal when maxWallClockMs is reached under a fake clock", () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;

    const meter = new BudgetMeter({
      budgets: { maxSteps: 100, maxUsd: 10.0, maxWallClockMs: 5000 },
      now,
    });

    expect(meter.isExceeded).toBe(false);
    expect(meter.msUsed).toBe(0);

    // Advance 4000ms
    currentTime += 4000;
    expect(meter.check().isExceeded).toBe(false);
    expect(meter.msUsed).toBe(4000);

    // Advance another 1500ms (total 5500ms > 5000ms)
    currentTime += 1500;
    const status = meter.check();
    expect(status.isExceeded).toBe(true);
    expect(status.exceeded).toBe("wallClock");
    expect(meter.signal.aborted).toBe(true);
    expect(meter.exceededReason).toBe("wallClock");
  });

  it("handles wrap-up slice reservation correctly", () => {
    const meter = new BudgetMeter({
      budgets: { maxSteps: 5, maxUsd: 10.0, maxWallClockMs: 60_000 },
      wrapUpSteps: 1,
    });

    // Steps 0..3: normal execution allowed
    meter.recordStep(3);
    expect(meter.isWrapUpReserved).toBe(false);
    expect(meter.canExecuteTurn()).toBe(true);

    // Step 4: hits reserved wrap-up boundary (5 - 1 = 4)
    meter.recordStep(1);
    expect(meter.stepsUsed).toBe(4);
    expect(meter.isWrapUpReserved).toBe(true);
    expect(meter.canExecuteTurn()).toBe(false); // blocked from normal execution

    // Activate wrap-up
    expect(meter.startWrapUp()).toBe(true);
    expect(meter.wrapUpActive).toBe(true);
    expect(meter.canExecuteTurn()).toBe(true); // wrap-up turn allowed

    // Step 5: wrap-up turn executes
    meter.recordStep(1);
    expect(meter.stepsUsed).toBe(5);
    expect(meter.isExceeded).toBe(true);
    expect(meter.canExecuteTurn()).toBe(false);
  });

  it("calculates remaining budget correctly", () => {
    let currentTime = 1000;
    const meter = new BudgetMeter({
      budgets: { maxSteps: 10, maxUsd: 5.0, maxWallClockMs: 20_000 },
      now: () => currentTime,
    });

    meter.recordStep(3);
    meter.recordUsage("cli-agent", { inputTokens: 100, outputTokens: 50, usd: 1.5 });
    currentTime += 5000;

    const remaining = meter.getRemaining();
    expect(remaining.stepsRemaining).toBe(7);
    expect(remaining.usdRemaining).toBeCloseTo(3.5);
    expect(remaining.msRemaining).toBe(15_000);
  });

  it("creates valid budget.checked trace events", () => {
    const meter = new BudgetMeter({
      budgets: { maxSteps: 10, maxUsd: 2.0, maxWallClockMs: 10_000 },
      now: () => 1_700_000_000_000,
    });

    meter.recordStep(2);
    const event = meter.createBudgetCheckedEvent({ runId: "r1", seq: 5 });

    expect(event).toEqual({
      runId: "r1",
      seq: 5,
      ts: 1_700_000_000_000,
      kind: "budget.checked",
      steps: { used: 2, max: 10 },
      usd: { used: 0, max: 2.0 },
      ms: { used: 0, max: 10_000 },
      exceeded: null,
    });
  });

  it("supports manual abort", () => {
    const meter = new BudgetMeter({
      budgets: { maxSteps: 10, maxUsd: 2.0, maxWallClockMs: 10_000 },
    });

    expect(meter.signal.aborted).toBe(false);
    meter.abort("User stopped run");
    expect(meter.signal.aborted).toBe(true);
  });
});
