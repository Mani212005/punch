import type { TraceEvent } from "@punch/shared";

export interface CompensationTrace {
  write(event: TraceEvent): unknown;
}

/** One undo step registered before its forward action runs (plan.md 3.6 step 8). */
export interface CompensationStep {
  /** Traced as `compensation.ran.action`, e.g. "delete_branch". */
  action: string;
  undo: () => Promise<void>;
}

/**
 * Undo registry for multi-step irreversible sequences. Steps run in reverse
 * order; each outcome is traced as `compensation.ran`.
 */
export class CompensationRegistry {
  private readonly steps: CompensationStep[] = [];

  constructor(
    private readonly trace?: CompensationTrace,
    private readonly runId: string = "run",
    private readonly seq: number = 0,
  ) {}

  /** Register the undo for a forward action that is about to run. */
  register(step: CompensationStep): void {
    this.steps.push(step);
  }

  get size(): number {
    return this.steps.length;
  }

  /** Run every registered undo in reverse order, tracing each outcome. */
  async compensateAll(detailPrefix?: string): Promise<{ ok: boolean; ran: number }> {
    let allOk = true;
    let ran = 0;
    for (const step of [...this.steps].reverse()) {
      ran += 1;
      try {
        await step.undo();
        await this.trace?.write({
          runId: this.runId,
          seq: this.seq,
          ts: Date.now(),
          kind: "compensation.ran",
          action: step.action,
          ok: true,
          detail: detailPrefix,
        });
      } catch (error) {
        allOk = false;
        await this.trace?.write({
          runId: this.runId,
          seq: this.seq,
          ts: Date.now(),
          kind: "compensation.ran",
          action: step.action,
          ok: false,
          detail:
            `${detailPrefix ?? ""} ${error instanceof Error ? error.message : String(error)}`.trim(),
        });
      }
    }
    this.steps.length = 0;
    return { ok: allOk, ran };
  }

  /** The forward sequence succeeded: forget the undo steps without running them. */
  clear(): void {
    this.steps.length = 0;
  }
}
