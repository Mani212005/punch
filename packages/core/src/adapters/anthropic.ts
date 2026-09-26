import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterRunInput,
  AgentAdapter,
  AgentEntry,
  AgentEvent,
  Pricing,
  Provider,
  ToolSpec,
} from "@punch/shared";
import {
  AsyncQueue,
  GARBAGE_RESULT,
  NO_CHAOS,
  ResultGate,
  describeError,
  errorMessage,
  killAfterTurns,
  measuredUsage,
  stringifyToolOutput,
  type AgentChaos,
} from "./agent.js";

export const WRITE_RESULT_TOOL = "write_result";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that predate adaptive thinking and `output_config.effort`. */
const LEGACY_MODEL = /(haiku|claude-3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0)/;
/** Models where policy classifiers can refuse; server-side fallbacks are on by default here. */
const FALLBACK_MODEL = /(fable|mythos|opus-5)/;

export interface ToolCall {
  name: string;
  input: unknown;
  callId: string;
  signal: AbortSignal;
}

/** Runs an engine tool (the A3 registry in production, a test double in unit tests). */
export type ToolExecutor = (call: ToolCall) => Promise<unknown>;

export interface AnthropicAdapterOptions {
  /** Model id exactly as the user entered it in config; never defaulted here. */
  model: string;
  /** Provider id, matched against `provider-down:<providerId>` chaos. */
  providerId: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /** Injected in tests; otherwise built from `apiKeyEnv`. */
  client?: Anthropic;
  pricing?: Pricing;
  chaos?: AgentChaos;
  executeTool?: ToolExecutor;
  maxTokens?: number;
  /** `"default"` routes refusals server-side; `false` disables. Defaults on for Fable/Opus 5 models. */
  fallbacks?: "default" | false;
}

const EFFORT_CAPABLE = (model: string): boolean => !LEGACY_MODEL.test(model);

export function createAnthropicAdapter(
  agent: AgentEntry,
  provider: Provider,
  options: Partial<AnthropicAdapterOptions> = {},
): AnthropicAdapter {
  return new AnthropicAdapter({
    model: agent.model,
    providerId: provider.id,
    ...(provider.kind === "anthropic"
      ? {
          apiKeyEnv: provider.apiKeyEnv,
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        }
      : {}),
    ...(agent.pricing ? { pricing: agent.pricing } : {}),
    ...options,
  });
}

/** Wire schema for `write_result`: the subtask schema nested under `result`, `$defs` hoisted. */
function writeResultInputSchema(resultSchema: Record<string, unknown>): Record<string, unknown> {
  const { $defs, definitions, ...rest } = resultSchema;
  return {
    type: "object",
    properties: { result: rest },
    required: ["result"],
    ...($defs ? { $defs } : {}),
    ...(definitions ? { definitions } : {}),
  };
}

function toolInputParser(schema: Record<string, unknown>): (raw: unknown) => unknown {
  let validator: z.ZodType | undefined;
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    validator = undefined;
  }
  return (raw) => (validator ? validator.parse(raw) : raw);
}

const PROTOCOL = `When your work is complete, call the ${WRITE_RESULT_TOOL} tool exactly once with the final result under "result". It is validated against the required schema; if it is rejected, correct it and call ${WRITE_RESULT_TOOL} again. Do not end your turn without calling it.`;

export class AnthropicAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    effort: true,
  };
  private client: Anthropic | undefined;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.client = options.client;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.options.apiKeyEnv ? process.env[this.options.apiKeyEnv] : undefined;
      this.client = new Anthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(this.options.baseUrl ? { baseURL: this.options.baseUrl } : {}),
      });
    }
    return this.client;
  }

  private get chaos(): AgentChaos {
    return this.options.chaos ?? NO_CHAOS;
  }

  private get providerDown(): boolean {
    return this.chaos.providerDown.includes(this.options.providerId);
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    if (this.providerDown) {
      return { ok: false, detail: "503 provider unavailable (chaos: provider-down)" };
    }
    try {
      const reply = await this.getClient().messages.create({
        model: this.options.model,
        max_tokens: 256,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      if (reply.stop_reason === "refusal")
        return { ok: false, detail: "model refused the test call" };
      return { ok: true, detail: `${this.options.model} responded` };
    } catch (err) {
      return { ok: false, detail: describeError(err) };
    }
  }

  async *run(input: AdapterRunInput): AsyncGenerator<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const stop = new AbortController();
    void this.drive(input, queue, stop).finally(() => queue.end());
    try {
      yield* queue.drain();
    } finally {
      stop.abort();
    }
  }

  private async drive(
    input: AdapterRunInput,
    queue: AsyncQueue<AgentEvent>,
    stop: AbortController,
  ): Promise<void> {
    const { model, pricing } = this.options;
    const finish = (status: "ok" | "error" | "refusal" | "max_turns", error?: string): void => {
      queue.push({ type: "done", status, ...(error === undefined ? {} : { error }) });
    };

    if (this.providerDown) {
      finish("error", `503 provider unavailable (chaos: provider-down:${this.options.providerId})`);
      return;
    }

    const gate = new ResultGate(input.resultSchema);
    const garbage = input.role !== undefined && this.chaos.garbage.includes(input.role);
    const killAt = killAfterTurns(this.chaos, input.role);
    let turns = 0;
    let killed = false;
    let refusal: string | null = null;
    let lastStopReason: string | null = null;

    queue.push({ type: "heartbeat" });

    const writeResult: BetaRunnableTool<{ result: unknown }> = {
      name: WRITE_RESULT_TOOL,
      description:
        "Submit the final result of this subtask. Validated against the required schema; " +
        "an invalid result is returned to you once for correction.",
      input_schema: writeResultInputSchema(
        input.resultSchema,
      ) as Anthropic.Beta.BetaTool.InputSchema,
      parse: (raw) => z.object({ result: z.unknown() }).parse(raw) as { result: unknown },
      run: ({ result }) => {
        const verdict = gate.submit(garbage ? GARBAGE_RESULT : result);
        if (verdict.ok) {
          stop.abort();
          return "Result accepted.";
        }
        if (verdict.terminal) stop.abort();
        throw new Error(
          `Result rejected by schema validation: ${verdict.error}. Call ${WRITE_RESULT_TOOL} again with a corrected result.`,
        );
      },
    };

    const engineTools = input.tools.map((spec) => this.runnableTool(spec, queue, input.signal));

    const signal = AbortSignal.any([input.signal, stop.signal]);
    const useFallbacks = this.options.fallbacks ?? (FALLBACK_MODEL.test(model) ? "default" : false);
    const modern = EFFORT_CAPABLE(model);

    try {
      const runner = this.getClient().beta.messages.toolRunner(
        {
          model,
          max_tokens: this.options.maxTokens ?? 32_000,
          system: `${input.system}\n\n${PROTOCOL}`,
          messages: [{ role: "user", content: renderTask(input) }],
          tools: [...engineTools, writeResult],
          max_iterations: input.maxTurns,
          stream: true,
          ...(modern
            ? { thinking: { type: "adaptive" as const }, output_config: { effort: input.effort } }
            : {}),
          ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: useFallbacks } : {}),
        },
        { signal },
      );

      for await (const stream of runner) {
        const blocks = new Map<number, string>();
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            blocks.set(event.index, (blocks.get(event.index) ?? "") + event.delta.text);
            queue.push({ type: "heartbeat" });
          } else if (event.type === "content_block_stop") {
            const text = blocks.get(event.index);
            blocks.delete(event.index);
            if (text) queue.push({ type: "text", text });
          } else {
            queue.push({ type: "heartbeat" });
          }
        }
        const message = await stream.finalMessage();
        turns += 1;
        lastStopReason = message.stop_reason;
        const u = message.usage;
        queue.push({
          type: "usage",
          usage: measuredUsage(
            {
              inputTokens:
                u.input_tokens +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0),
              outputTokens: u.output_tokens,
            },
            pricing,
          ),
        });
        if (message.stop_reason === "refusal") {
          const category = message.stop_details?.category;
          refusal = `model refused the request${category ? ` (${category})` : ""}`;
          break;
        }
        if (killAt !== undefined && turns >= killAt && message.stop_reason === "tool_use") {
          killed = true;
          break;
        }
      }
    } catch (err) {
      if (input.signal.aborted) {
        finish("error", "aborted");
        return;
      }
      if (!gate.accepted && gate.failure === null) {
        finish("error", describeError(err));
        return;
      }
      // Otherwise the abort came from our own stop after a terminal write_result.
    }

    if (input.signal.aborted) return finish("error", "aborted");
    if (gate.accepted) {
      queue.push({ type: "result", output: gate.value });
      return finish("ok");
    }
    if (gate.failure !== null) return finish("error", gate.failure);
    if (refusal !== null) return finish("refusal", refusal);
    if (killed) {
      return finish(
        "error",
        `agent crashed after ${turns} turns (chaos: kill-after:${input.role}:${turns})`,
      );
    }
    if (lastStopReason === "tool_use" || turns >= input.maxTurns) {
      return finish(
        "max_turns",
        `reached maxTurns (${input.maxTurns}) without ${WRITE_RESULT_TOOL}`,
      );
    }
    return finish("error", `agent ended its turn without calling ${WRITE_RESULT_TOOL}`);
  }

  private runnableTool(
    spec: ToolSpec,
    queue: AsyncQueue<AgentEvent>,
    runSignal: AbortSignal,
  ): BetaRunnableTool<unknown> {
    const executor = this.options.executeTool;
    return {
      name: spec.name,
      description: spec.description,
      input_schema: {
        ...spec.inputSchema,
        type: "object",
      } as Anthropic.Beta.BetaTool.InputSchema,
      parse: toolInputParser(spec.inputSchema),
      run: async (input, context) => {
        const callId = context?.toolUse.id ?? `call_${spec.name}`;
        queue.push({ type: "tool_call", callId, tool: spec.name, input });
        try {
          if (!executor) throw new Error(`no executor registered for tool ${spec.name}`);
          const output = await executor({
            name: spec.name,
            input,
            callId,
            signal: context?.signal ?? runSignal,
          });
          queue.push({ type: "tool_result", callId, tool: spec.name, ok: true, output });
          return stringifyToolOutput(output);
        } catch (err) {
          queue.push({
            type: "tool_result",
            callId,
            tool: spec.name,
            ok: false,
            output: errorMessage(err),
          });
          throw err;
        }
      },
    };
  }
}

function renderTask(input: AdapterRunInput): string {
  const inputs = Object.keys(input.inputs).length
    ? `\n\n<inputs>\n${JSON.stringify(input.inputs, null, 2)}\n</inputs>`
    : "";
  return `<task>\n${input.task}\n</task>${inputs}`;
}
