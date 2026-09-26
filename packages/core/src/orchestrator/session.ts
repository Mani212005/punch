import type { AdapterRunInput, AgentAdapter, AgentEvent, Config } from "@punch/shared";
import type { AdapterRegistry } from "../run/registry.js";
import type { Jev } from "../router/jev.js";
import {
  ORCHESTRATOR_TOOL_SPECS,
  executeOrchestratorTool,
  resolveOrchestratorAgent,
  type ManualSelection,
  type OrchestratorToolDeps,
  type RunStartReceipt,
  type RunStatusReport,
} from "./tools.js";

export interface SessionTranscriptMessage {
  from: "user" | "engine";
  text: string;
  at: number;
}

/**
 * Narration for the session SSE (plan.md 4.3 conversation tile). The run trace
 * stays the audit trail; narration is the orchestrator talking about it.
 */
export interface OrchestratorNarration {
  at: number;
  kind: "text" | "tool_call" | "tool_result" | "tool_error" | "failure";
  text: string;
}

export interface OrchestratorSessionOptions {
  sessionId: string;
  config: Config;
  mode: "auto" | "manual";
  orchestratorAgentId?: string;
  jev: Jev;
  adapters: AdapterRegistry;
  /** Launches the run and returns a receipt immediately; the run continues on its own. */
  createRun: (input: {
    repoUrl: string;
    brief?: string;
    budgetUsd?: number;
    assignments?: ManualSelection[];
  }) => Promise<RunStartReceipt>;
  getRunStatus: (runId: string) => Promise<RunStatusReport>;
  answerApproval: OrchestratorToolDeps["answerApproval"];
  manualSelections?: ManualSelection[];
  transcript?: SessionTranscriptMessage[];
  now?: () => number;
  maxTurns?: number;
  onNarration?: (event: OrchestratorNarration) => void;
}

const ORCHESTRATOR_SYSTEM = [
  "You are the Punch orchestrator. You talk to the user, write the task brief,",
  "consult the router with consult_router, launch runs with start_run, check them with",
  "get_run_status, and relay the human's approval decisions with answer_approval.",
  "In manual mode you never override the user's agent selection: start_run refuses",
  "anything that differs from it. You never decide approvals yourself: answer_approval",
  "only relays a decision whose decidedBy names the human. Narrate what is happening",
  "in plain words as you go.",
].join(" ");

const ORCHESTRATOR_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
};

/**
 * The orchestrator session (plan.md 3.4): the user-chosen agent (tool-calling
 * adapters only: Anthropic or Gemini) with the four engine tools. Narration
 * streams to `onNarration` (the session SSE); the run never depends on the
 * orchestrator, so an orchestrator failure is narrated like any slot failure
 * and the run continues (plan.md 2.7).
 */
export class OrchestratorSession {
  readonly sessionId: string;
  mode: "auto" | "manual";
  orchestratorAgentId: string;
  transcript: SessionTranscriptMessage[] = [];
  runIds: string[] = [];
  narrations: OrchestratorNarration[] = [];

  private readonly config: Config;
  private readonly jev: Jev;
  private readonly adapters: AdapterRegistry;
  private readonly createRun: OrchestratorSessionOptions["createRun"];
  private readonly getRunStatusFn: OrchestratorSessionOptions["getRunStatus"];
  private readonly answerApprovalFn: OrchestratorToolDeps["answerApproval"];
  private manualSelections: ManualSelection[];
  private readonly now: () => number;
  private readonly maxTurns: number;
  private readonly onNarration?: (event: OrchestratorNarration) => void;

  constructor(options: OrchestratorSessionOptions) {
    this.sessionId = options.sessionId;
    this.config = options.config;
    this.mode = options.mode;
    this.orchestratorAgentId =
      options.orchestratorAgentId ?? options.config.defaults.orchestratorAgentId ?? "unassigned";
    this.jev = options.jev;
    this.adapters = options.adapters;
    this.createRun = options.createRun;
    this.getRunStatusFn = options.getRunStatus;
    this.answerApprovalFn = options.answerApproval;
    this.manualSelections = [...(options.manualSelections ?? [])];
    this.transcript = [...(options.transcript ?? [])];
    this.now = options.now ?? (() => Date.now());
    this.maxTurns = options.maxTurns ?? 8;
    this.onNarration = options.onNarration;
  }

  setManualSelections(selections: ManualSelection[]): void {
    this.manualSelections = [...selections];
  }

  getManualSelections(): ManualSelection[] {
    return [...this.manualSelections];
  }

  private narrate(kind: OrchestratorNarration["kind"], text: string): void {
    const event: OrchestratorNarration = { at: this.now(), kind, text };
    this.narrations.push(event);
    this.onNarration?.(event);
  }

  private toolDeps(): OrchestratorToolDeps {
    return {
      config: this.config,
      mode: this.mode,
      jev: this.jev,
      getManualSelections: () => this.getManualSelections(),
      startRun: async (input) => {
        const receipt = await this.createRun(input);
        if (!this.runIds.includes(receipt.runId)) this.runIds.push(receipt.runId);
        return receipt;
      },
      getRunStatus: (runId) => this.getRunStatusFn(runId),
      answerApproval: (input) => this.answerApprovalFn(input),
    };
  }

  /**
   * One user turn: runs the orchestrator agent with the four engine tools and
   * returns its reply. Never throws for an agent failure: the failure is
   * narrated and a fallback reply is returned, while any launched run continues.
   */
  async handleUserMessage(text: string, signal?: AbortSignal): Promise<string> {
    this.transcript.push({ from: "user", text, at: this.now() });
    let reply: string;
    try {
      reply = await this.runAgent(text, signal ?? new AbortController().signal);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.narrate(
        "failure",
        `Orchestrator failed (${detail}); any running investigation continues.`,
      );
      reply =
        "The orchestrator hit a problem just now, but any running investigation continues " +
        `on its own. (${detail}) Ask me to check its status and I will pick up from there.`;
    }
    this.transcript.push({ from: "engine", text: reply, at: this.now() });
    return reply;
  }

  private async runAgent(userText: string, signal: AbortSignal): Promise<string> {
    const { agent, provider } = resolveOrchestratorAgent(this.config, this.orchestratorAgentId);
    const deps = this.toolDeps();
    const adapter: AgentAdapter = this.adapters.create({
      agent,
      provider,
      executeTool: async ({ name, input }) => executeOrchestratorTool(deps, name, input as unknown),
      chaos: { providerDown: [], garbage: [], killAfter: [] },
    });
    if (!adapter.capabilities.toolCalling) {
      throw new Error(
        `orchestrator agent "${agent.id}" cannot call tools; choose an Anthropic or Gemini agent`,
      );
    }
    const input: AdapterRunInput = {
      role: undefined,
      system: ORCHESTRATOR_SYSTEM,
      task: userText,
      inputs: {
        mode: this.mode,
        manualSelections: this.getManualSelections(),
        runIds: [...this.runIds],
      },
      tools: ORCHESTRATOR_TOOL_SPECS,
      resultSchema: ORCHESTRATOR_RESULT_SCHEMA,
      effort: "medium",
      maxTurns: this.maxTurns,
      signal,
    };
    const stream: AsyncIterable<AgentEvent> = adapter.run(input);
    let finalReply: string | null = null;
    for await (const event of stream) {
      switch (event.type) {
        case "text":
          this.narrate("text", event.text);
          break;
        case "opaque_output":
          this.narrate("text", event.text);
          break;
        case "tool_call":
          this.narrate("tool_call", `${event.tool} ${JSON.stringify(event.input) ?? ""}`);
          break;
        case "tool_result":
          this.narrate(
            "tool_result",
            `${event.tool} ${event.ok ? "ok" : "failed"}: ${truncate(String(JSON.stringify(event.output) ?? ""))}`,
          );
          break;
        case "result": {
          const parsed = parseReply(event.output);
          if (parsed !== null) finalReply = parsed;
          break;
        }
        case "done":
          if (event.status !== "ok") {
            throw new Error(
              event.status === "refusal"
                ? `orchestrator refused: ${event.error ?? "no detail"}`
                : (event.error ?? `orchestrator ended with status ${event.status}`),
            );
          }
          break;
        case "heartbeat":
        case "usage":
          break;
      }
    }
    if (finalReply === null) {
      const lastText = [...this.narrations].reverse().find((n) => n.kind === "text");
      finalReply =
        lastText?.text ?? "Done. Ask me to check the run status and I will pick up from there.";
    }
    return finalReply;
  }

  toJSON(): {
    sessionId: string;
    mode: "auto" | "manual";
    orchestratorAgentId: string;
    manualSelections: ManualSelection[];
    transcript: SessionTranscriptMessage[];
    runIds: string[];
  } {
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      orchestratorAgentId: this.orchestratorAgentId,
      manualSelections: this.getManualSelections(),
      transcript: [...this.transcript],
      runIds: [...this.runIds],
    };
  }
}

function parseReply(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const reply = (output as { reply?: unknown }).reply;
    if (typeof reply === "string") return reply;
  }
  return null;
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
