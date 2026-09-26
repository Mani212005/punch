import { z } from "zod";
import type { Pricing, Usage } from "@punch/shared";
import { calculateCost } from "../budget.js";

/**
 * Push-based async queue: a producer (the SDK loop, tool executions) pushes events while the
 * adapter's `run()` generator drains them. `end` closes it after the buffered items.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.closed = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

/** Chaos hooks an adapter honors (plan.md 2.6). `stall` is handled by the run loop, not here. */
export interface AgentChaos {
  /** Provider ids whose every call fails with 503. */
  providerDown: string[];
  /** Roles whose `write_result` is replaced with schema-invalid output. */
  garbage: string[];
  /** Roles whose agent dies after this many turns. */
  killAfter: { role: string; turns: number }[];
}

export const NO_CHAOS: AgentChaos = { providerDown: [], garbage: [], killAfter: [] };

/** Parses `provider-down:<id>`, `garbage:<role>`, `kill-after:<role>:<n>`; other profiles are ignored. */
export function parseAgentChaos(profiles: readonly string[]): AgentChaos {
  const chaos: AgentChaos = { providerDown: [], garbage: [], killAfter: [] };
  for (const profile of profiles) {
    const [kind, a, b] = profile.split(":");
    if (kind === "provider-down" && a) chaos.providerDown.push(a);
    else if (kind === "garbage" && a) chaos.garbage.push(a);
    else if (kind === "kill-after" && a && b && Number.isInteger(Number(b))) {
      chaos.killAfter.push({ role: a, turns: Number(b) });
    }
  }
  return chaos;
}

export function killAfterTurns(chaos: AgentChaos, role: string | undefined): number | undefined {
  return role === undefined ? undefined : chaos.killAfter.find((k) => k.role === role)?.turns;
}

/** The value `garbage:<role>` substitutes for a result: never valid for an object or array schema. */
export const GARBAGE_RESULT = "\u0000chaos-garbage";

export type ResultValidation = { ok: true; value: unknown } | { ok: false; error: string };

/** Validates a candidate result against the subtask's JSON Schema. */
export function validateResult(schema: Record<string, unknown>, value: unknown): ResultValidation {
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    return { ok: false, error: `result schema could not be compiled: ${errorMessage(err)}` };
  }
  const parsed = validator.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: detail };
}

/**
 * Tracks result validation across the one correction round allowed by plan.md 2.1: the first
 * invalid result is sent back for correction, the second is terminal.
 */
export class ResultGate {
  private attempts = 0;
  value: unknown;
  accepted = false;
  failure: string | null = null;

  constructor(private readonly schema: Record<string, unknown>) {}

  submit(candidate: unknown): ResultValidation & { terminal: boolean } {
    this.attempts += 1;
    const verdict = validateResult(this.schema, candidate);
    if (verdict.ok) {
      this.accepted = true;
      this.value = verdict.value;
      return { ...verdict, terminal: true };
    }
    const terminal = this.attempts >= 2;
    if (terminal) this.failure = `result failed schema validation twice: ${verdict.error}`;
    return { ...verdict, terminal };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTTP status carried by an SDK or fetch error, if any. */
export function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** `503 message` style text so Jev and the code classifier can read the status back out. */
export function describeError(err: unknown): string {
  const status = errorStatus(err);
  return status === undefined ? errorMessage(err) : `${status} ${errorMessage(err)}`;
}

/** Usage event payload with USD from per-agent pricing when configured (plan.md 3.7). */
export function measuredUsage(
  tokens: { inputTokens: number; outputTokens: number },
  pricing?: Pricing,
): Usage {
  const usage: Usage = { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens };
  const cost = calculateCost(usage, pricing);
  return cost.metered ? { ...usage, usd: cost.costUsd } : usage;
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? "null";
  } catch {
    return String(output);
  }
}
