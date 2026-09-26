import { z } from "zod";
import type { Effort } from "./common.js";
import type { BlackboardEntry } from "./blackboard.js";

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** Events an adapter yields; every one bears a heartbeat for the slot supervisor (plan.md 3.3). */
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("opaque_output"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
    output: z.unknown(),
  }),
  z.object({ type: z.literal("usage"), usage: Usage }),
  z.object({ type: z.literal("result"), output: z.unknown() }),
  z.object({
    type: z.literal("done"),
    status: z.enum(["ok", "error", "refusal", "max_turns"]),
    error: z.string().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  irreversible?: boolean;
}

export interface AdapterCapabilities {
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  effort: boolean;
}

export interface AdapterRunInput {
  system: string;
  task: string;
  inputs: Record<string, BlackboardEntry | unknown>;
  tools: ToolSpec[];
  /** JSON Schema the final `write_result` must satisfy. */
  resultSchema: Record<string, unknown>;
  effort: Effort;
  maxTurns: number;
  signal: AbortSignal;
}

export interface AgentAdapter {
  capabilities: AdapterCapabilities;
  run(input: AdapterRunInput): AsyncIterable<AgentEvent>;
  test(): Promise<{ ok: boolean; detail: string }>;
}
