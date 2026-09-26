import type { AdapterRunInput, AgentAdapter, AgentEvent } from "@punch/shared";
import { GARBAGE_RESULT } from "../adapters/agent.js";

/**
 * Agent-level chaos profiles from plan.md 2.6. They are applied by decorating whatever adapter
 * fills the slot, so fixture, API and CLI agents fail the same way. Role-scoped profiles hit the
 * agent originally assigned to the slot; a replacement is never sabotaged. Provider-scoped
 * profiles hit every agent of that provider, which is what makes standby skipping observable.
 */
export interface SlotChaos {
  providerDown: string[];
  rateLimit: string[];
  stall: string[];
  timeout: string[];
  garbage: string[];
  hallucinate: string[];
  killAfter: { role: string; turns: number }[];
}

export const NO_SLOT_CHAOS: SlotChaos = {
  providerDown: [],
  rateLimit: [],
  stall: [],
  timeout: [],
  garbage: [],
  hallucinate: [],
  killAfter: [],
};

/** `provider-down:<id>`, `rate-limit:<id>`, `stall|timeout|garbage|hallucinate:<role>`, `kill-after:<role>:<n>`. */
export function parseSlotChaos(profiles: readonly string[]): SlotChaos {
  const chaos: SlotChaos = {
    providerDown: [],
    rateLimit: [],
    stall: [],
    timeout: [],
    garbage: [],
    hallucinate: [],
    killAfter: [],
  };
  for (const profile of profiles) {
    const [kind, a, b] = profile.split(":");
    if (!a) continue;
    switch (kind) {
      case "provider-down":
        chaos.providerDown.push(a);
        break;
      case "rate-limit":
        chaos.rateLimit.push(a);
        break;
      case "stall":
        chaos.stall.push(a);
        break;
      case "timeout":
        chaos.timeout.push(a);
        break;
      case "garbage":
        chaos.garbage.push(a);
        break;
      case "hallucinate":
        chaos.hallucinate.push(a);
        break;
      case "kill-after":
        if (b !== undefined && Number.isInteger(Number(b)) && Number(b) >= 0) {
          chaos.killAfter.push({ role: a, turns: Number(b) });
        }
        break;
      default:
        break;
    }
  }
  return chaos;
}

export interface ChaosAdapterOptions {
  chaos: SlotChaos;
  providerId: string;
  /** True while this is the agent the slot started with. Evaluated per run. */
  isFirstAgent: () => boolean;
  /** Gap between the heartbeats a `timeout` agent keeps emitting. */
  heartbeatMs?: number;
}

/** Waits until the signal aborts; the way a stalled or endless agent behaves. */
function untilAborted(signal: AbortSignal, ms?: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = ms === undefined ? undefined : setTimeout(done, ms);
    function done(): void {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function hasSlotChaos(chaos: SlotChaos): boolean {
  return Object.values(chaos).some((v) => v.length > 0);
}

/** A cited tool call that never happened: the critic's pre-check cannot find it in the trace. */
function hallucinate(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const value = output as { evidence?: unknown };
  if (!Array.isArray(value.evidence)) return output;
  return {
    ...value,
    evidence: [
      ...value.evidence,
      {
        claim:
          "The affected package was fixed in version 99.0.0 (per the maintainers' security bulletin).",
        source: "osv_query",
        toolCallId: "call-that-never-happened",
        quote: "fixed: 99.0.0",
      },
    ],
  };
}

export function chaosAdapter(inner: AgentAdapter, options: ChaosAdapterOptions): AgentAdapter {
  const { chaos, providerId } = options;
  return {
    capabilities: inner.capabilities,
    test: () => inner.test(),
    async *run(input: AdapterRunInput): AsyncGenerator<AgentEvent> {
      if (chaos.providerDown.includes(providerId)) {
        yield {
          type: "done",
          status: "error",
          error: `503 service unavailable (chaos provider-down:${providerId})`,
        };
        return;
      }
      if (chaos.rateLimit.includes(providerId)) {
        yield {
          type: "done",
          status: "error",
          error: `429 too many requests, retry-after 1s (chaos rate-limit:${providerId})`,
        };
        return;
      }
      const role = input.role ?? "";
      const targeted = options.isFirstAgent();
      const has = (list: string[]) => targeted && list.includes(role);

      if (has(chaos.stall)) {
        yield { type: "text", text: "Starting work." };
        await untilAborted(input.signal);
        return;
      }
      if (has(chaos.timeout)) {
        while (!input.signal.aborted) {
          yield { type: "heartbeat" };
          await untilAborted(input.signal, options.heartbeatMs ?? 1000);
        }
        return;
      }
      const killAt = targeted ? chaos.killAfter.find((k) => k.role === role)?.turns : undefined;
      if (killAt === 0) throw new Error(`agent process crashed (chaos kill-after:${role}:0)`);
      const garbage = has(chaos.garbage);
      const liar = has(chaos.hallucinate);
      let toolResults = 0;
      for await (const event of inner.run(input)) {
        if (event.type === "result" && garbage) {
          yield { type: "result", output: GARBAGE_RESULT };
          continue;
        }
        if (event.type === "result" && liar) {
          yield { type: "result", output: hallucinate(event.output) };
          continue;
        }
        yield event;
        if (event.type === "tool_result") {
          toolResults += 1;
          if (killAt !== undefined && toolResults >= killAt) {
            throw new Error(`agent process crashed (chaos kill-after:${role}:${killAt})`);
          }
        }
      }
    },
  };
}
