import { z } from "zod";
import type { BlackboardEntry, Finding } from "@punch/shared";
import {
  Evidence,
  type AdapterRunInput,
  type AgentAdapter,
  type AgentEvent,
  type Effort,
  type SlotRole,
  type Subtask,
  type ToolSpec,
} from "@punch/shared";
import { validateResult } from "../adapters/agent.js";
import type { ToolExecutor } from "../adapters/anthropic.js";
import type { ApprovalGate } from "../approval.js";
import type { Blackboard } from "../blackboard.js";
import { TOOL_SPECS, executeTool, type ToolExecutionContext } from "../tools/registry.js";

/** Agent bound to a slot: the adapter plus the identity stamped on everything it writes. */
export interface RoleAgent {
  agentId: string;
  displayName?: string;
  adapter: AgentAdapter;
}

export interface RoleDeps {
  agent: RoleAgent;
  /** Fed from the adapter's tool events; the critic reads it as the trace view. */
  ledger: ToolLedger;
  signal?: AbortSignal;
  effort?: Effort;
  maxTurns?: number;
  /** Every adapter event, for heartbeats and trace forwarding by the run loop. */
  onEvent?: (event: AgentEvent) => void;
}

/** What a producing role hands to the critic before anything reaches the blackboard. */
export interface Draft {
  value: unknown;
  evidence: Evidence[];
  status: "ok" | "degraded";
  degradedReason?: string;
}

/** Findings from the critic plus the draft they were about; the one revision turn's input. */
export interface Revision {
  findings: Finding[];
  previous: Draft;
}

export interface ProducerInput {
  subtask: Subtask;
  inputs: Record<string, BlackboardEntry>;
  brief?: string;
  revision?: Revision;
}

/** A role run that ended without a valid result; the supervisor (A9) classifies it. */
export class RoleRunError extends Error {
  constructor(
    readonly role: SlotRole,
    readonly status: "error" | "refusal" | "max_turns" | "no_result" | "malformed",
    detail: string,
  ) {
    super(`${role} run ${status}: ${detail}`);
    this.name = "RoleRunError";
  }
}

// ---------------------------------------------------------------------------
// Trace view over tool calls
// ---------------------------------------------------------------------------

export interface LedgerCall {
  callId: string;
  tool: string;
  input: unknown;
  ok?: boolean;
  output?: unknown;
}

/** Tool calls observed in agent events, keyed by call id. Read-only to the critic. */
export class ToolLedger {
  private readonly calls = new Map<string, LedgerCall>();

  record(event: AgentEvent): void {
    if (event.type === "tool_call") {
      this.calls.set(event.callId, { callId: event.callId, tool: event.tool, input: event.input });
    } else if (event.type === "tool_result") {
      const call = this.calls.get(event.callId) ?? {
        callId: event.callId,
        tool: event.tool,
        input: undefined,
      };
      this.calls.set(event.callId, { ...call, ok: event.ok, output: event.output });
    }
  }

  toolCall(callId: string): LedgerCall | undefined {
    return this.calls.get(callId);
  }

  all(): LedgerCall[] {
    return [...this.calls.values()];
  }
}

// ---------------------------------------------------------------------------
// Running an adapter for a role
// ---------------------------------------------------------------------------

export interface RoleRun {
  role: SlotRole;
  subtaskId?: string;
  system: string;
  task: string;
  inputs: Record<string, unknown>;
  tools: ToolSpec[];
  resultSchema: Record<string, unknown>;
  defaultMaxTurns: number;
}

/** Drives one adapter run to its validated `write_result` output. */
export async function runRole(
  deps: RoleDeps,
  run: RoleRun,
): Promise<{ output: unknown; text: string }> {
  const input: AdapterRunInput = {
    role: run.role,
    system: run.system,
    task: run.task,
    inputs: run.inputs,
    tools: run.tools,
    resultSchema: run.resultSchema,
    effort: deps.effort ?? "medium",
    maxTurns: deps.maxTurns ?? run.defaultMaxTurns,
    signal: deps.signal ?? new AbortController().signal,
  };
  let output: unknown;
  let hasResult = false;
  let text = "";
  let done: Extract<AgentEvent, { type: "done" }> | undefined;
  for await (const event of deps.agent.adapter.run(input)) {
    deps.ledger.record(event);
    deps.onEvent?.(event);
    if (event.type === "text") text += event.text;
    else if (event.type === "result") {
      output = event.output;
      hasResult = true;
    } else if (event.type === "done") done = event;
  }
  if (done && done.status !== "ok") {
    throw new RoleRunError(run.role, done.status, done.error ?? done.status);
  }
  if (!hasResult)
    throw new RoleRunError(run.role, "no_result", "adapter finished without a result");
  // Adapters validate too; this guards adapters (CLI) that only relay the agent's text.
  const checked = validateResult(run.resultSchema, output);
  if (!checked.ok) throw new RoleRunError(run.role, "malformed", checked.error);
  return { output: checked.value, text };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export function jsonSchemaOf(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  delete jsonSchema["$schema"];
  return jsonSchema;
}

export const GENERIC_OBJECT_SCHEMA: Record<string, unknown> = { type: "object" };

/** Result envelope for producing roles: the subtask value, its evidence, and an honest degraded flag. */
export function producerResultSchema(subtask: Subtask): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      value: subtask.output.schema ?? GENERIC_OBJECT_SCHEMA,
      evidence: jsonSchemaOf(z.array(Evidence)),
      degradedReason: {
        type: "string",
        description: "Set only when required data could not be obtained; explains what is unknown.",
      },
    },
    required: ["value", "evidence"],
  };
}

const ProducerEnvelope = z.object({
  value: z.unknown(),
  evidence: z.array(Evidence),
  degradedReason: z.string().optional(),
});

export function draftFromEnvelope(role: SlotRole, output: unknown): Draft {
  const parsed = ProducerEnvelope.safeParse(output);
  if (!parsed.success) throw new RoleRunError(role, "malformed", parsed.error.message);
  const { value, evidence, degradedReason } = parsed.data;
  return {
    value,
    evidence,
    status: degradedReason ? "degraded" : "ok",
    ...(degradedReason ? { degradedReason } : {}),
  };
}

/** Text block describing the revision turn: the critic's findings against the previous draft. */
export function revisionText(revision: Revision | undefined): string {
  if (!revision) return "";
  return [
    "",
    "REVISION REQUIRED. The critic rejected your previous draft. Fix every finding below, drop any claim you cannot support with evidence, and resubmit.",
    "Findings:",
    JSON.stringify(revision.findings, null, 2),
    "Previous draft:",
    JSON.stringify(
      { value: revision.previous.value, evidence: revision.previous.evidence },
      null,
      2,
    ),
  ].join("\n");
}

/** Writes an accepted draft as the subtask's blackboard entry (a new version when the key exists). */
export function commitDraft(
  blackboard: Blackboard,
  subtask: Subtask,
  writer: { role: SlotRole; agentId: string },
  draft: Draft,
): BlackboardEntry {
  return blackboard.writeNewVersion({
    key: subtask.output.key,
    value: draft.value,
    evidence: draft.evidence,
    status: draft.status,
    writtenBy: { role: writer.role, agentId: writer.agentId, subtaskId: subtask.id },
  });
}

// ---------------------------------------------------------------------------
// Tool sets and the executor that binds them to a role
// ---------------------------------------------------------------------------

export const READ_BLACKBOARD_TOOL: ToolSpec = {
  name: "read_blackboard",
  description: "Read the latest blackboard entry for a key: value, status, evidence, writer.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", description: "Blackboard key" } },
    required: ["key"],
  },
};

export const LIST_BLACKBOARD_TOOL: ToolSpec = {
  name: "list_blackboard",
  description: "List every blackboard key with its version and status.",
  inputSchema: { type: "object", properties: {} },
};

export const GET_TOOL_RESULT_TOOL: ToolSpec = {
  name: "get_tool_result",
  description:
    "Read the recorded input and output of an earlier tool call by call id (trace, read only).",
  inputSchema: {
    type: "object",
    properties: { callId: { type: "string" } },
    required: ["callId"],
  },
};

const READ_ONLY_TOOLS = [READ_BLACKBOARD_TOOL, LIST_BLACKBOARD_TOOL, GET_TOOL_RESULT_TOOL];

/** Researcher, inventory and impact: every reversible A3 tool. Executor: blackboard reads and the gated issue tool. Critic: reads only. */
export function toolsForRole(role: SlotRole): ToolSpec[] {
  switch (role) {
    case "researcher":
    case "inventory":
    case "impact":
      return Object.values(TOOL_SPECS).filter((spec) => !spec.irreversible);
    case "executor":
      return [READ_BLACKBOARD_TOOL, LIST_BLACKBOARD_TOOL, TOOL_SPECS["github_create_issue"]!];
    case "critic":
    case "reachability":
    case "investigator":
      // E1 adds the repository source tools for reachability; until then reads only.
      return READ_ONLY_TOOLS;
    case "planner":
      return [];
  }
}

export interface RoleToolExecutorOptions {
  role: SlotRole;
  blackboard: Blackboard;
  ledger: ToolLedger;
  agentId?: string;
  subtaskId?: string;
  /** Cache, chaos, clients, trace sink for the A3 registry. */
  context?: ToolExecutionContext;
  /** Irreversible tools pause here; without one the registry falls back to its own default. */
  approvalGate?: ApprovalGate;
  /** Injected in tests. */
  run?: typeof executeTool;
}

/**
 * The `executeTool` an adapter is constructed with for this role. Enforces the role's tool set,
 * serves the read-only tools locally, and sends everything else through the A3 registry (which
 * owns cache, chaos and the approval gate).
 */
export function createRoleToolExecutor(options: RoleToolExecutorOptions): ToolExecutor {
  const allowed = new Set(toolsForRole(options.role).map((t) => t.name));
  const run = options.run ?? executeTool;
  return async (call) => {
    if (!allowed.has(call.name)) {
      throw new Error(`tool ${call.name} is not available to the ${options.role} role`);
    }
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case READ_BLACKBOARD_TOOL.name: {
        const entry = options.blackboard.get(String(input["key"]));
        if (!entry) throw new Error(`blackboard key "${String(input["key"])}" not found`);
        return entry;
      }
      case LIST_BLACKBOARD_TOOL.name:
        return options.blackboard.list().map((e) => ({
          key: e.key,
          version: e.version,
          status: e.status,
          writtenBy: e.writtenBy,
        }));
      case GET_TOOL_RESULT_TOOL.name: {
        const found = options.ledger.toolCall(String(input["callId"]));
        if (!found) throw new Error(`no recorded tool call ${String(input["callId"])}`);
        return found;
      }
    }
    const result = await run(call.name, input, {
      ...options.context,
      callId: call.callId,
      role: options.role,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.subtaskId ? { subtaskId: options.subtaskId } : {}),
      ...(options.approvalGate ? { approvalGate: options.approvalGate } : {}),
      signal: call.signal,
    });
    if (!result.ok) {
      const denied = result.status === "denied" ? "approval denied: " : "";
      throw new Error(`${denied}${result.error ?? "tool failed"}`);
    }
    return result.output;
  };
}
