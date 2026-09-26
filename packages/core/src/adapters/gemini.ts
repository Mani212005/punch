import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionCall,
  GenerateContentResponseUsageMetadata,
  Part,
  ThinkingLevel,
} from "@google/genai";

import type {
  AdapterCapabilities,
  AdapterRunInput,
  AgentAdapter,
  AgentEvent,
  Pricing,
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
  type AgentChaos,
} from "./agent.js";

export const WRITE_RESULT_TOOL = "write_result";

export interface ToolCall {
  name: string;
  input: unknown;
  callId: string;
  signal: AbortSignal;
}

export type ToolExecutor = (call: ToolCall) => Promise<unknown>;

export interface GeminiAdapterOptions {
  model: string;
  providerId: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  pricing?: Pricing;
  chaos?: AgentChaos;
  executeTool?: ToolExecutor;
  maxTokens?: number;
  client?: GoogleGenAI;
}

const THINKING_CAPABLE = (model: string): boolean => /(thinking|gemini-2\.5)/i.test(model);

export class GeminiAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    toolCalling: true,
    structuredOutput: true, // We map JSON Schema to parametersJsonSchema
    streaming: true,
    effort: true,
  };

  private chaos: AgentChaos;

  constructor(private readonly options: GeminiAdapterOptions) {
    this.chaos = options.chaos ?? NO_CHAOS;
  }

  private get providerDown(): boolean {
    return this.chaos.providerDown.includes(this.options.providerId);
  }

  private getClient(): GoogleGenAI {
    if (this.options.client) return this.options.client;
    const apiKey = this.options.apiKeyEnv ? process.env[this.options.apiKeyEnv] : undefined;
    return new GoogleGenAI({ apiKey, httpOptions: { baseUrl: this.options.baseUrl } });
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    if (this.providerDown) {
      return { ok: false, detail: "503 provider unavailable (chaos: provider-down)" };
    }
    try {
      await this.getClient().models.generateContent({
        model: this.options.model,
        contents: "Reply with the single word: ok",
        config: { maxOutputTokens: 256 },
      });
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

    queue.push({ type: "heartbeat" });

    const tools = [
      ...input.tools.map((spec) => ({
        name: spec.name,
        description: spec.description,
        parametersJsonSchema: spec.inputSchema,
      })),
      {
        name: WRITE_RESULT_TOOL,
        description:
          "Submit the final result of this subtask. Validated against the required schema; " +
          "an invalid result is returned to you once for correction.",
        parametersJsonSchema: {
          type: "object",
          properties: { result: input.resultSchema },
          required: ["result"],
        },
      },
    ];

    const signal = AbortSignal.any([input.signal, stop.signal]);
    const modern = THINKING_CAPABLE(model);

    // Gemini effort mapping
    const thinkingLevel =
      input.effort === "high" ? "high" : input.effort === "low" ? "low" : "medium";

    const config = {
      systemInstruction: { role: "system", parts: [{ text: `${input.system}\n\n${PROTOCOL}` }] },
      tools: [{ functionDeclarations: tools }],
      maxOutputTokens: this.options.maxTokens ?? 32000,
      abortSignal: signal,
      ...(modern ? { thinkingConfig: { thinkingLevel: thinkingLevel as ThinkingLevel } } : {}),
    };

    const contents: Content[] = [{ role: "user", parts: [{ text: renderTask(input) }] }];

    try {
      while (turns < input.maxTurns) {
        if (signal.aborted) break;

        const runner = await this.getClient().models.generateContentStream({
          model,
          contents,
          config,
        });

        let currentText = "";
        const functionCalls: FunctionCall[] = [];

        let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

        for await (const chunk of runner) {
          if (signal.aborted) break;
          queue.push({ type: "heartbeat" });
          if (chunk.text) {
            queue.push({ type: "text", text: chunk.text });
            currentText += chunk.text;
          }
          if (chunk.functionCalls) {
            functionCalls.push(...chunk.functionCalls);
          }
          if (chunk.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }
        }

        if (signal.aborted) break;

        turns += 1;

        if (usageMetadata) {
          queue.push({
            type: "usage",
            usage: measuredUsage(
              {
                inputTokens: usageMetadata.promptTokenCount ?? 0,
                outputTokens: usageMetadata.candidatesTokenCount ?? 0,
              },
              pricing,
            ),
          });
        }

        if (killAt !== undefined && turns >= killAt && functionCalls.length > 0) {
          killed = true;
          break;
        }

        const modelParts: Part[] = [];
        if (currentText) {
          modelParts.push({ text: currentText });
        }
        if (functionCalls.length > 0) {
          modelParts.push(...functionCalls.map((fc) => ({ functionCall: fc })));
        }
        contents.push({ role: "model", parts: modelParts });

        if (functionCalls.length === 0) {
          // Model stopped without calling tools
          break;
        }

        const userParts: Part[] = [];
        for (const call of functionCalls) {
          if (!call.name) continue;
          const callId = call.id ?? `call_${call.name}`;
          if (call.name === WRITE_RESULT_TOOL) {
            queue.push({ type: "tool_call", callId, tool: call.name, input: call.args });
            const verdict = gate.submit(garbage ? GARBAGE_RESULT : call.args?.result);
            if (verdict.ok) {
              queue.push({
                type: "tool_result",
                callId,
                tool: call.name,
                ok: true,
                output: "Result accepted.",
              });
              userParts.push({
                functionResponse: { name: call.name, response: { result: "Result accepted." } },
              });
              stop.abort();
            } else {
              if (verdict.terminal) {
                queue.push({
                  type: "tool_result",
                  callId,
                  tool: call.name,
                  ok: false,
                  output: verdict.error,
                });
                userParts.push({
                  functionResponse: { name: call.name, response: { error: verdict.error } },
                });
                stop.abort();
              } else {
                const errStr = `Result rejected by schema validation: ${verdict.error}. Call ${WRITE_RESULT_TOOL} again with a corrected result.`;
                queue.push({
                  type: "tool_result",
                  callId,
                  tool: call.name,
                  ok: false,
                  output: errStr,
                });
                userParts.push({
                  functionResponse: { name: call.name, response: { error: errStr } },
                });
              }
            }
          } else {
            const spec = input.tools.find((t) => t.name === call.name);
            if (spec) {
              queue.push({ type: "tool_call", callId, tool: call.name, input: call.args });
              try {
                if (!this.options.executeTool)
                  throw new Error(`no executor registered for tool ${call.name}`);
                const output = await this.options.executeTool({
                  name: call.name,
                  input: call.args,
                  callId,
                  signal,
                });
                queue.push({ type: "tool_result", callId, tool: call.name, ok: true, output });
                userParts.push({ functionResponse: { name: call.name, response: { output } } });
              } catch (err) {
                queue.push({
                  type: "tool_result",
                  callId,
                  tool: call.name,
                  ok: false,
                  output: errorMessage(err),
                });
                userParts.push({
                  functionResponse: { name: call.name, response: { error: errorMessage(err) } },
                });
              }
            } else {
              userParts.push({
                functionResponse: { name: call.name, response: { error: "Unknown tool" } },
              });
            }
          }
        }

        if (gate.accepted || gate.failure !== null) {
          break;
        }

        contents.push({ role: "user", parts: userParts });
      }
    } catch (err) {
      if (input.signal.aborted || stop.signal.aborted) {
        // Handled below
      } else {
        finish("error", describeError(err));
        return;
      }
    }

    if (input.signal.aborted) return finish("error", "aborted");
    if (gate.accepted) {
      queue.push({ type: "result", output: gate.value });
      return finish("ok");
    }
    if (gate.failure !== null) return finish("error", gate.failure);
    if (killed) {
      return finish(
        "error",
        `agent crashed after ${turns} turns (chaos: kill-after:${input.role}:${turns})`,
      );
    }
    if (turns >= input.maxTurns) {
      return finish(
        "max_turns",
        `reached maxTurns (${input.maxTurns}) without ${WRITE_RESULT_TOOL}`,
      );
    }
    return finish("error", `agent ended its turn without calling ${WRITE_RESULT_TOOL}`);
  }
}

const PROTOCOL = `When your work is complete, call the ${WRITE_RESULT_TOOL} tool exactly once with the final result under "result". It is validated against the required schema; if it is rejected, correct it and call ${WRITE_RESULT_TOOL} again. Do not end your turn without calling it.`;

function renderTask(input: AdapterRunInput): string {
  const inputs = Object.keys(input.inputs).length
    ? `\n\n<inputs>\n${JSON.stringify(input.inputs, null, 2)}\n</inputs>`
    : "";
  return `<task>\n${input.task}\n</task>${inputs}`;
}
