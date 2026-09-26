import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEntry, AgentEvent, Provider } from "@punch/shared";
import { AntigravityAdapter, createAntigravityAdapter } from "./antigravity.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../../../fixtures/cli");
const FAKE_ANTIGRAVITY = path.join(FIXTURES_DIR, "fake-antigravity.js");

function testRunInput(overrides: Partial<AdapterRunInput> = {}): AdapterRunInput {
  return {
    system: "You are an Antigravity agent.",
    task: "Audit dependencies.",
    inputs: {},
    tools: [],
    resultSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              package: { type: "string" },
              latest: { type: "string" },
            },
            required: ["package", "latest"],
          },
        },
      },
      required: ["findings"],
    },
    effort: "high",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("AntigravityAdapter", () => {
  it("declares capabilities with toolCalling: false and streaming: true", () => {
    const adapter = new AntigravityAdapter({
      model: "gemini-3.8-flash-high",
      providerId: "antigravity",
      binary: FAKE_ANTIGRAVITY,
    });
    expect(adapter.capabilities).toEqual({
      toolCalling: false,
      structuredOutput: false,
      streaming: true,
      effort: true,
    });
  });

  it("test() checks binary version", async () => {
    const adapter = new AntigravityAdapter({
      model: "gemini-3.8-flash-high",
      providerId: "antigravity",
      binary: FAKE_ANTIGRAVITY,
    });
    const res = await adapter.test();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("1.2.11");
  });

  it("completes a run yielding heartbeats, text, opaque_output, result, and done", async () => {
    const adapter = new AntigravityAdapter({
      model: "gemini-3.8-flash-high",
      providerId: "antigravity",
      binary: FAKE_ANTIGRAVITY,
    });
    const events = await collectEvents(adapter.run(testRunInput()));

    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "opaque_output")).toBe(true);

    const result = events.find((e) => e.type === "result");
    expect(result).toEqual({
      type: "result",
      output: { findings: [{ package: "axios", latest: "1.7.0" }] },
    });

    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", status: "ok" });
  });

  it("handles malformed output with correction round", async () => {
    const adapter = new AntigravityAdapter({
      model: "gemini-3.8-flash-high",
      providerId: "antigravity",
      binary: FAKE_ANTIGRAVITY,
      env: { FAKE_CLI_MODE: "malformed_once" },
    });
    const events = await collectEvents(adapter.run(testRunInput()));

    expect(
      events.some(
        (e) =>
          e.type === "opaque_output" &&
          e.text.includes("Result schema validation failed") &&
          e.text.includes("Starting correction round"),
      ),
    ).toBe(true);

    expect(events.find((e) => e.type === "result")).toEqual({
      type: "result",
      output: { findings: [{ package: "axios", latest: "1.7.0" }] },
    });
    expect(events.find((e) => e.type === "done")).toEqual({ type: "done", status: "ok" });
  });

  it("createAntigravityAdapter factory creates adapter from AgentEntry and Provider", () => {
    const agent: AgentEntry = {
      id: "agy-agent",
      displayName: "Antigravity Agent",
      providerId: "antigravity-provider",
      model: "gemini-3.8-flash-high",
      costTier: "medium",
      roles: ["researcher", "critic"],
      strengths: "Fast reasoning",
    };
    const provider: Provider = {
      id: "antigravity-provider",
      kind: "antigravity",
      binary: FAKE_ANTIGRAVITY,
    };

    const adapter = createAntigravityAdapter(agent, provider);
    expect(adapter).toBeInstanceOf(AntigravityAdapter);
    expect(adapter.capabilities.toolCalling).toBe(false);
  });
});
