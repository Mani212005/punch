import Anthropic from "@anthropic-ai/sdk";
import type { AdapterRunInput, AgentEvent } from "@punch/shared";

type Block = { type: string; [key: string]: unknown };
export interface FixtureMessage {
  id: string;
  role: "assistant";
  model: string;
  stop_reason: string;
  stop_sequence: null;
  stop_details?: unknown;
  content: Block[];
  usage: Record<string, number>;
}

export type Turn = FixtureMessage | { error: number; message?: string } | { hang: true };

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Renders a recorded Message as the SSE stream the Messages API sends for `stream: true`. */
export function messageToSse(message: FixtureMessage): string {
  let body = sse("message_start", {
    type: "message_start",
    message: {
      ...message,
      type: "message",
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1 },
    },
  });
  message.content.forEach((block, index) => {
    const start: Block =
      block.type === "text"
        ? { type: "text", text: "" }
        : block.type === "tool_use"
          ? { ...block, input: {} }
          : block.type === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : block;
    body += sse("content_block_start", { type: "content_block_start", index, content_block: start });
    if (block.type === "text") {
      const text = String(block.text);
      const mid = Math.ceil(text.length / 2);
      for (const piece of [text.slice(0, mid), text.slice(mid)]) {
        body += sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        });
      }
    } else if (block.type === "tool_use") {
      body += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === "thinking") {
      body += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: String(block.signature ?? "sig") },
      });
    }
    body += sse("content_block_stop", { type: "content_block_stop", index });
  });
  body += sse("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      ...(message.stop_details ? { stop_details: message.stop_details } : {}),
    },
    usage: { output_tokens: message.usage.output_tokens },
  });
  body += sse("message_stop", { type: "message_stop" });
  return body;
}

export interface MockAnthropic {
  client: Anthropic;
  /** Parsed JSON bodies of every request the client made. */
  requests: Record<string, unknown>[];
}

/** A real SDK client whose transport serves the given turns in order. No network. */
export function mockAnthropic(turns: Turn[]): MockAnthropic {
  const requests: Record<string, unknown>[] = [];
  let next = 0;
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const turn = turns[next++];
    if (!turn) throw new Error("mock: no more recorded turns");
    if ("hang" in turn) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        init?.signal?.addEventListener("abort", abort);
      });
    }
    if ("error" in turn) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: turn.message ?? "upstream error" },
        }),
        { status: turn.error, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(messageToSse(turn), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
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
