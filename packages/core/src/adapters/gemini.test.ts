import type { AgentEvent } from "@punch/shared";
import { describe, expect, it } from "vitest";
import { parseAgentChaos } from "./agent.js";
import { GeminiAdapter, type GeminiAdapterOptions } from "./gemini.js";
import { collect, mockGemini, runInput, type Turn } from "./gemini.test-helpers.js";
import { WRITE_RESULT_TOOL } from "./gemini.js";

const done = (events: AgentEvent[]) => events.filter((e) => e.type === "done");

function adapter(turns: Turn[], overrides: Partial<GeminiAdapterOptions> = {}) {
  const mock = mockGemini(turns);
  const adapter = new GeminiAdapter({
    model: "gemini-2.0-flash",
    providerId: "gemini",
    client: mock.client,
    ...overrides,
  });
  return { adapter, mock };
}

describe("GeminiAdapter", () => {
  it("runs a subtask to completion with tools and write_result", async () => {
    const turns: Turn[] = [
      {
        text: "I will look up lodash.",
        functionCalls: [{ id: "call1", name: "npm_lookup", args: { name: "lodash" } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
      },
      {
        functionCalls: [
          {
            id: "call2",
            name: WRITE_RESULT_TOOL,
            args: { result: { findings: [{ package: "lodash", latest: "4.17.21" }] } },
          },
        ],
        usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 10 },
      },
    ];

    const { adapter: a, mock } = adapter(turns, {
      executeTool: async () => ({ name: "lodash", latest: "4.17.21" }),
    });

    const events = await collect(a.run(runInput()));

    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ tool: "npm_lookup", input: { name: "lodash" } });
    expect(tools[1]).toMatchObject({ tool: WRITE_RESULT_TOOL });

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);

    expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    expect(mock.requests).toHaveLength(2);

    // Check effort level
    const firstRequest = mock.requests[0] as Record<string, unknown>;
    expect((firstRequest.config as { thinkingConfig?: unknown }).thinkingConfig).toBeUndefined(); // gemini-2.0-flash is not THINKING_CAPABLE by our regex
  });

  it("passes thinking config for thinking models", async () => {
    const turns: Turn[] = [
      {
        functionCalls: [
          {
            id: "call2",
            name: WRITE_RESULT_TOOL,
            args: { result: { findings: [{ package: "lodash", latest: "4.17.21" }] } },
          },
        ],
        usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 10 },
      },
    ];

    const mock = mockGemini(turns);
    const a = new GeminiAdapter({
      model: "gemini-2.0-flash-thinking-exp",
      providerId: "gemini",
      client: mock.client,
    });
    await collect(a.run(runInput({ effort: "high" })));
    const firstRequest = mock.requests[0] as Record<string, unknown>;
    expect((firstRequest.config as { thinkingConfig?: unknown }).thinkingConfig).toEqual({
      thinkingLevel: "high",
    });
  });

  it("fails terminally when the result is invalid twice", async () => {
    const badTurn: Turn = {
      functionCalls: [{ id: "call2", name: WRITE_RESULT_TOOL, args: { result: "not an object" } }],
    };
    const { adapter: a, mock } = adapter([badTurn, badTurn]);
    const events = await collect(a.run(runInput({ tools: [] })));
    expect(events.some((e) => e.type === "result")).toBe(false);
    const [end] = done(events);
    expect(end).toMatchObject({ status: "error" });
    expect(end).toHaveProperty("error", expect.stringContaining("failed schema validation twice"));
    expect(mock.requests).toHaveLength(2);
  });

  it("reports max_turns when the cap is hit without write_result", async () => {
    const toolTurn: Turn = {
      functionCalls: [{ id: "call1", name: "npm_lookup", args: { name: "lodash" } }],
    };
    const { adapter: a, mock } = adapter([toolTurn, toolTurn], {
      executeTool: async () => ({ name: "lodash", latest: "4.17.21" }),
    });
    const events = await collect(a.run(runInput({ maxTurns: 2 })));
    expect(done(events)).toEqual([
      { type: "done", status: "max_turns", error: "reached maxTurns (2) without write_result" },
    ]);
    expect(mock.requests).toHaveLength(2);
  });

  it("fails when the model ends its turn without write_result", async () => {
    const { adapter: a } = adapter([{ text: "All done." }]);
    const events = await collect(a.run(runInput()));
    expect(done(events)[0]).toMatchObject({ status: "error" });
  });

  it("feeds tool errors back to the model and reports tool_result ok=false", async () => {
    const turns: Turn[] = [
      { functionCalls: [{ id: "call1", name: "npm_lookup", args: { name: "lodash" } }] },
      {
        functionCalls: [
          { id: "call2", name: WRITE_RESULT_TOOL, args: { result: { findings: [] } } },
        ],
      },
    ];
    const { adapter: a } = adapter(turns, {
      executeTool: async () => {
        throw new Error("404 not found");
      },
    });
    const events = await collect(a.run(runInput()));
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      ok: false,
      output: "404 not found",
    });
    expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
  });

  it("classifies API failures as done(error) instead of throwing", async () => {
    const { adapter: a } = adapter([{ error: 503, message: "overloaded" }]);
    const events = await collect(a.run(runInput()));
    const [end] = done(events);
    expect(end).toMatchObject({ status: "error" });
    expect(end).toHaveProperty("error", expect.stringMatching(/^503 /));
  });

  it("stops promptly when aborted mid-request", async () => {
    const controller = new AbortController();
    const { adapter: a } = adapter([{ hang: true }]);
    const started = Date.now();

    // We pass abortSignal in GenerateContentConfig which our mock respects
    const pending = collect(a.run(runInput({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 20);
    const events = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(done(events)).toEqual([{ type: "done", status: "error", error: "aborted" }]);
  });

  describe("chaos", () => {
    it("provider-down fails every call with 503 and never touches the API", async () => {
      const { adapter: a, mock } = adapter([{ text: "ok" }], {
        chaos: parseAgentChaos(["provider-down:gemini"]),
      });
      const events = await collect(a.run(runInput()));
      const [end] = done(events);
      expect(end).toMatchObject({ status: "error" });
      expect(end).toHaveProperty("error", expect.stringMatching(/^503 /));
      expect(mock.requests).toHaveLength(0);
      expect(await a.test()).toMatchObject({ ok: false });
    });

    it("provider-down for another provider is ignored", async () => {
      const { adapter: a } = adapter(
        [{ functionCalls: [{ name: WRITE_RESULT_TOOL, args: { result: { findings: [] } } }] }],
        {
          chaos: parseAgentChaos(["provider-down:anthropic"]),
        },
      );
      const events = await collect(a.run(runInput()));
      expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    });

    it("garbage:<role> degrades to a terminal failure instead of crashing", async () => {
      const good: Turn = {
        functionCalls: [{ name: WRITE_RESULT_TOOL, args: { result: { findings: [] } } }],
      };
      const { adapter: a } = adapter([good, good], {
        chaos: parseAgentChaos(["garbage:researcher"]),
      });
      const events = await collect(a.run(runInput({ tools: [] })));
      expect(events.some((e) => e.type === "result")).toBe(false);
      expect(done(events)[0]).toMatchObject({ status: "error" });
      expect(done(events)[0]).toHaveProperty(
        "error",
        expect.stringContaining("failed schema validation twice"),
      );
    });

    it("kill-after:<role>:<n> ends the agent after n turns", async () => {
      const { adapter: a, mock } = adapter(
        [{ functionCalls: [{ name: "npm_lookup", args: {} }] }],
        {
          chaos: parseAgentChaos(["kill-after:researcher:1"]),
        },
      );
      const events = await collect(a.run(runInput()));
      expect(events.some((e) => e.type === "result")).toBe(false);
      expect(done(events)[0]).toMatchObject({ status: "error" });
      expect(done(events)[0]).toHaveProperty("error", expect.stringContaining("kill-after"));
      expect(mock.requests).toHaveLength(1);
    });
  });

  describe("test()", () => {
    it("makes one minimal non-streaming call", async () => {
      const { adapter: a, mock } = adapter([{ text: "ok" }]);
      expect(await a.test()).toEqual({ ok: true, detail: "gemini-2.0-flash responded" });
      expect(mock.requests).toHaveLength(1);
    });

    it("reports failures as detail, not exceptions", async () => {
      const { adapter: a } = adapter([{ error: 401, message: "invalid x-api-key" }]);
      const result = await a.test();
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/^401 /);
    });
  });
});
