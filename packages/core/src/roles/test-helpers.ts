import type {
  AdapterRunInput,
  AgentAdapter,
  AgentEvent,
  BlackboardEntry,
  Subtask,
} from "@punch/shared";
import type { ToolExecutor } from "../adapters/anthropic.js";
import type { RoleAgent, RoleDeps } from "./common.js";
import { ToolLedger } from "./common.js";

export type Script = (
  input: AdapterRunInput,
  exec: (name: string, input: unknown, callId: string) => Promise<unknown>,
) => Promise<AgentEvent[]> | AgentEvent[];

/** Adapter double: each `run()` consumes the next script, optionally calling the role's tool executor. */
export function scriptedAdapter(
  scripts: Script[],
  executor?: ToolExecutor,
): AgentAdapter & { inputs: AdapterRunInput[] } {
  const inputs: AdapterRunInput[] = [];
  let next = 0;
  return {
    inputs,
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true, effort: true },
    async test() {
      return { ok: true, detail: "mock" };
    },
    async *run(input) {
      inputs.push(input);
      const script = scripts[next++];
      if (!script) throw new Error("scriptedAdapter: no more scripts");
      const exec = async (name: string, toolInput: unknown, callId: string) => {
        if (!executor) throw new Error("no executor");
        return executor({ name, input: toolInput, callId, signal: input.signal });
      };
      for (const event of await script(input, exec)) yield event;
    },
  };
}

export const result = (output: unknown): AgentEvent[] => [
  { type: "result", output },
  { type: "done", status: "ok" },
];

export function deps(
  adapter: AgentAdapter,
  agentId = "agent-a",
  ledger = new ToolLedger(),
): RoleDeps & { agent: RoleAgent; ledger: ToolLedger } {
  return { agent: { agentId, adapter }, ledger };
}

export function subtask(over: Partial<Subtask> = {}): Subtask {
  return {
    id: "s1",
    title: "Look up qs",
    description: "Find the latest qs version.",
    dependsOn: [],
    roleHint: "researcher",
    output: {
      key: "qs_latest",
      schema: {
        type: "object",
        properties: { package: { type: "string" }, latest: { type: "string" } },
        required: ["package", "latest"],
      },
    },
    inputKeys: [],
    status: "pending",
    ...over,
  };
}

export function entry(over: Partial<BlackboardEntry> & { key: string }): BlackboardEntry {
  return {
    version: 1,
    status: "ok",
    value: {},
    evidence: [],
    writtenBy: { role: "researcher", agentId: "r", subtaskId: "s0" },
    ts: 1,
    ...over,
  };
}
