import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@punch/shared";
import { parseAgentChaos } from "./agent.js";
import { AnthropicAdapter } from "./anthropic.js";
import {
  collect,
  mockAnthropic,
  runInput,
  type FixtureMessage,
  type Turn,
} from "./anthropic.test-helpers.js";

const fixture = (name: string): { turns: FixtureMessage[] } =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/anthropic/${name}.json`, import.meta.url), "utf8"),
  );

const npmTool = async ({ name }: { name: string }): Promise<unknown> => ({
  name,
  latest: "4.17.21",
});

function adapter(
  turns: Turn[],
  extra: Partial<ConstructorParameters<typeof AnthropicAdapter>[0]> = {},
) {
  const mock = mockAnthropic(turns);
  const a = new AnthropicAdapter({
    model: "claude-opus-5",
    providerId: "anthropic",
    client: mock.client,
    executeTool: (call) => npmTool(call.input as { name: string }),
    ...extra,
  });
  return { adapter: a, mock };
}

const done = (events: AgentEvent[]) => events.filter((e) => e.type === "done");
const types = (events: AgentEvent[]) => events.map((e) => e.type);

const invalidResultTurn = (id: string): FixtureMessage => ({
  id,
  role: "assistant",
  model: "claude-opus-5",
  stop_reason: "tool_use",
  stop_sequence: null,
  content: [
    {
      type: "tool_use",
      id: `toolu_${id}`,
      name: "write_result",
      input: { result: { findings: "nope" } },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 10 },
});

describe("AnthropicAdapter", () => {
  it("completes a fixture subtask: tool call, result, usage and cost", async () => {
    const { turns } = fixture("subtask-complete");
    const { adapter: a, mock } = adapter(turns, {
      pricing: { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    });
    const events = await collect(a.run(runInput()));

    expect(events.find((e) => e.type === "text")).toEqual({
      type: "text",
      text: "Checking the npm registry for lodash.",
    });
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      tool: "npm_lookup",
      input: { name: "lodash" },
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      ok: true,
      output: { latest: "4.17.21" },
    });
    expect(events.find((e) => e.type === "result")).toEqual({
      type: "result",
      output: { findings: [{ package: "lodash", latest: "4.17.21" }] },
    });
    expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    expect(events.at(-1)?.type).toBe("done");

    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(2);
    // second turn: 1400 input + 500 cache read, 60 output
    expect(usage[1]).toMatchObject({ usage: { inputTokens: 1900, outputTokens: 60 } });
    const usd = usage.reduce((sum, e) => sum + (e.type === "usage" ? (e.usage.usd ?? 0) : 0), 0);
    expect(usd).toBeCloseTo((1200 + 1900) * 5e-6 + (85 + 60) * 25e-6, 8);
    expect(types(events)).toContain("heartbeat");

    // Stopped after the accepted result: no third request.
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]).toMatchObject({
      model: "claude-opus-5",
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      fallbacks: "default",
    });
    const names = (mock.requests[0]?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["npm_lookup", "write_result"]);
  });

  it("omits thinking, effort and fallbacks for legacy models", async () => {
    const { turns } = fixture("subtask-complete");
    const { adapter: a, mock } = adapter(turns, { model: "claude-haiku-4-5" });
    await collect(a.run(runInput()));
    expect(mock.requests[0]).not.toHaveProperty("thinking");
    expect(mock.requests[0]).not.toHaveProperty("output_config");
    expect(mock.requests[0]).not.toHaveProperty("fallbacks");
    expect(mock.requests[0]).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("accepts a corrected result after one invalid write_result", async () => {
    const { turns } = fixture("subtask-complete");
    const good = turns[1]!;
    const { adapter: a, mock } = adapter([invalidResultTurn("bad1"), good]);
    const events = await collect(a.run(runInput({ tools: [] })));
    expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    expect(mock.requests).toHaveLength(2);
    const second = JSON.stringify(mock.requests[1]?.messages);
    expect(second).toContain("Result rejected by schema validation");
  });

  it("fails terminally when the result is invalid twice", async () => {
    const { adapter: a, mock } = adapter([invalidResultTurn("bad1"), invalidResultTurn("bad2")]);
    const events = await collect(a.run(runInput({ tools: [] })));
    expect(events.some((e) => e.type === "result")).toBe(false);
    const [end] = done(events);
    expect(end).toMatchObject({ status: "error" });
    expect(end).toHaveProperty("error", expect.stringContaining("failed schema validation twice"));
    expect(mock.requests).toHaveLength(2);
  });

  it("treats a refusal as a terminal failure", async () => {
    const { adapter: a } = adapter(fixture("refusal").turns);
    const events = await collect(a.run(runInput()));
    expect(done(events)).toEqual([
      { type: "done", status: "refusal", error: "model refused the request (cyber)" },
    ]);
  });

  it("reports max_turns when the cap is hit without write_result", async () => {
    const toolTurn = fixture("subtask-complete").turns[0]!;
    const { adapter: a, mock } = adapter([toolTurn, { ...toolTurn, id: "msg_again" }]);
    const events = await collect(a.run(runInput({ maxTurns: 2 })));
    expect(done(events)).toEqual([
      { type: "done", status: "max_turns", error: "reached maxTurns (2) without write_result" },
    ]);
    expect(mock.requests).toHaveLength(2);
  });

  it("fails when the model ends its turn without write_result", async () => {
    const chat: FixtureMessage = {
      id: "msg_chat",
      role: "assistant",
      model: "claude-opus-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "All done, nothing to report." }],
      usage: { input_tokens: 10, output_tokens: 8 },
    };
    const { adapter: a } = adapter([chat]);
    const events = await collect(a.run(runInput()));
    expect(done(events)[0]).toMatchObject({ status: "error" });
  });

  it("feeds tool errors back to the model and reports tool_result ok=false", async () => {
    const { turns } = fixture("subtask-complete");
    const { adapter: a, mock } = adapter(turns, {
      executeTool: async () => {
        throw new Error("404 not found");
      },
    });
    const events = await collect(a.run(runInput()));
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      ok: false,
      output: "404 not found",
    });
    expect(JSON.stringify(mock.requests[1]?.messages)).toContain("404 not found");
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
    const pending = collect(a.run(runInput({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 20);
    const events = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(done(events)).toEqual([{ type: "done", status: "error", error: "aborted" }]);
  });

  it("stops without a request when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter: a, mock } = adapter([{ hang: true }]);
    const events = await collect(a.run(runInput({ signal: controller.signal })));
    expect(done(events)).toEqual([{ type: "done", status: "error", error: "aborted" }]);
    expect(mock.requests.length).toBeLessThanOrEqual(1);
  });

  describe("chaos", () => {
    it("provider-down fails every call with 503 and never touches the API", async () => {
      const { adapter: a, mock } = adapter(fixture("subtask-complete").turns, {
        chaos: parseAgentChaos(["provider-down:anthropic"]),
      });
      const events = await collect(a.run(runInput()));
      const [end] = done(events);
      expect(end).toMatchObject({ status: "error" });
      expect(end).toHaveProperty("error", expect.stringMatching(/^503 /));
      expect(mock.requests).toHaveLength(0);
      expect(await a.test()).toMatchObject({ ok: false });
    });

    it("provider-down for another provider is ignored", async () => {
      const { adapter: a } = adapter(fixture("subtask-complete").turns, {
        chaos: parseAgentChaos(["provider-down:gemini"]),
      });
      const events = await collect(a.run(runInput()));
      expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    });

    it("garbage:<role> degrades to a terminal failure instead of crashing", async () => {
      const { turns } = fixture("subtask-complete");
      const good = turns[1]!;
      const { adapter: a } = adapter([good, { ...good, id: "msg_good2" }], {
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

    it("garbage for a different role leaves the run alone", async () => {
      const { adapter: a } = adapter(fixture("subtask-complete").turns, {
        chaos: parseAgentChaos(["garbage:critic"]),
      });
      const events = await collect(a.run(runInput()));
      expect(done(events)).toEqual([{ type: "done", status: "ok" }]);
    });

    it("kill-after:<role>:<n> ends the agent after n turns", async () => {
      const { adapter: a, mock } = adapter(fixture("subtask-complete").turns, {
        chaos: parseAgentChaos(["kill-after:researcher:1"]),
      });
      const events = await collect(a.run(runInput()));
      expect(events.some((e) => e.type === "result")).toBe(false);
      expect(done(events)[0]).toMatchObject({ status: "error" });
      expect(done(events)[0]).toHaveProperty("error", expect.stringContaining("kill-after"));
      expect(mock.requests).toHaveLength(1);
    });
  });

  describe("test()", () => {
    const okTurn: FixtureMessage = {
      id: "msg_t",
      role: "assistant",
      model: "claude-opus-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 8, output_tokens: 2 },
    };

    it("makes one minimal non-streaming call", async () => {
      const mock = mockAnthropic([]);
      const bodies: unknown[] = [];
      const client = mock.client;
      client.messages.create = (async (body: unknown) => {
        bodies.push(body);
        return okTurn;
      }) as never;
      const a = new AnthropicAdapter({ model: "claude-opus-5", providerId: "anthropic", client });
      expect(await a.test()).toEqual({ ok: true, detail: "claude-opus-5 responded" });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ model: "claude-opus-5", max_tokens: 256 });
    });

    it("reports failures as detail, not exceptions", async () => {
      const { adapter: a } = adapter([{ error: 401, message: "invalid x-api-key" }]);
      const result = await a.test();
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/^401 /);
    });
  });
});

describe("parseAgentChaos", () => {
  it("parses the adapter-level profiles and ignores the rest", () => {
    expect(
      parseAgentChaos([
        "provider-down:anthropic",
        "garbage:critic",
        "kill-after:researcher:3",
        "stall:executor",
      ]),
    ).toEqual({
      providerDown: ["anthropic"],
      garbage: ["critic"],
      killAfter: [{ role: "researcher", turns: 3 }],
    });
  });
});
