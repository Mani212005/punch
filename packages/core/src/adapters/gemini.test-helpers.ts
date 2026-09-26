import type { FunctionCall } from "@google/genai";
import { GoogleGenAI } from "@google/genai";
import type { AdapterRunInput, AgentEvent } from "@punch/shared";

export interface FixtureMessage {
  text?: string;
  functionCalls?: FunctionCall[];
  finishReason?: string;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  hang?: boolean;
  error?: number;
  message?: string;
}

export type Turn = FixtureMessage | { error: number; message?: string } | { hang: true };

export interface MockGemini {
  client: GoogleGenAI;
  requests: Record<string, unknown>[];
}

export function mockGemini(turns: Turn[]): MockGemini {
  const requests: Record<string, unknown>[] = [];
  let next = 0;

  const client = new GoogleGenAI({ apiKey: "test-key" }) as unknown as GoogleGenAI;
  client.models = {
    generateContent: async (params: unknown) => {
      requests.push(params);
      const turn = turns[next++];
      if (!turn) throw new Error("mock: no more recorded turns");
      if ("error" in turn) {
        throw new Error(`${turn.error} ${turn.message}`);
      }
      return { ok: true };
    },
    generateContentStream: async function* (params: unknown) {
      requests.push(params);
      const turn = turns[next++];
      if (!turn) throw new Error("mock: no more recorded turns");
      if ("hang" in turn) {
         await new Promise<void>((_resolve, reject) => {
             const abort = (): void => reject(new DOMException("aborted", "AbortError"));
             if (params.config?.abortSignal?.aborted) abort();
             params.config?.abortSignal?.addEventListener("abort", abort);
         });
      }
      if ("error" in turn) {
        throw new Error(`${turn.error} ${turn.message}`);
      }

      yield {
        text: turn.text,
        functionCalls: turn.functionCalls,
        candidates: [{ finishReason: turn.finishReason ?? "STOP" }],
        usageMetadata: turn.usageMetadata,
      };
    },
  };

  return { client, requests };
}

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { package: { type: "string" }, latest: { type: "string" } },
        required: ["package", "latest"],
      },
    },
  },
  required: ["findings"],
};

export function runInput(overrides: Partial<AdapterRunInput> = {}): AdapterRunInput {
  return {
    role: "researcher",
    system: "You are the researcher.",
    task: "Find the latest version of lodash.",
    inputs: {},
    tools: [
      {
        name: "npm_lookup",
        description: "Look up a package in the npm registry.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    ],
    resultSchema: RESULT_SCHEMA,
    effort: "medium",
    maxTurns: 6,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}
