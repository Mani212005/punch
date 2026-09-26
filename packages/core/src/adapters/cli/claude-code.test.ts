import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEntry, AgentEvent, Provider } from "@punch/shared";
import { ClaudeCodeAdapter, createClaudeCodeAdapter } from "./claude-code.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../../../fixtures/cli");
const FAKE_CLAUDE = path.join(FIXTURES_DIR, "fake-claude.js");

function testRunInput(overrides: Partial<AdapterRunInput> = {}): AdapterRunInput {
  return {
    system: "You are a Claude Code agent.",
    task: "Audit security vulnerabilities.",
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
    effort: "medium",
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

describe("ClaudeCodeAdapter", () => {
  it("declares capabilities with toolCalling: false and streaming: true", () => {
    const adapter = new ClaudeCodeAdapter({
      model: "claude-sonnet-4-5",
      providerId: "claude",
      binary: FAKE_CLAUDE,
    });
    expect(adapter.capabilities).toEqual({
      toolCalling: false,
      structuredOutput: false,
      streaming: true,
      effort: true,
    });
  });

  it("test() checks binary version", async () => {
    const adapter = new ClaudeCodeAdapter({
      model: "claude-sonnet-4-5",
      providerId: "claude",
      binary: FAKE_CLAUDE,
    });
    const res = await adapter.test();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("2.1.281");
  });

  it("completes a run yielding heartbeats, text, opaque_output, result, and done", async () => {
    const adapter = new ClaudeCodeAdapter({
      model: "claude-sonnet-4-5",
      providerId: "claude",
      binary: FAKE_CLAUDE,
    });
    const events = await collectEvents(adapter.run(testRunInput()));

    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "opaque_output" && e.text.includes("Bash"))).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);

    const result = events.find((e) => e.type === "result");
    expect(result).toEqual({
      type: "result",
      output: { findings: [{ package: "lodash", latest: "4.17.21" }] },
    });

    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", status: "ok" });
  });

  it("handles malformed output with correction round", async () => {
    const adapter = new ClaudeCodeAdapter({
      model: "claude-sonnet-4-5",
      providerId: "claude",
      binary: FAKE_CLAUDE,
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
      output: { findings: [{ package: "lodash", latest: "4.17.21" }] },
    });
    expect(events.find((e) => e.type === "done")).toEqual({ type: "done", status: "ok" });
  });

  it("createClaudeCodeAdapter factory creates adapter from AgentEntry and Provider", () => {
    const agent: AgentEntry = {
      id: "claude-researcher",
      displayName: "Claude Researcher",
      providerId: "claude-provider",
      model: "claude-opus-5",
      costTier: "high",
      roles: ["researcher"],
      strengths: "Deep analysis",
    };
    const provider: Provider = {
      id: "claude-provider",
      kind: "claude-code",
      binary: FAKE_CLAUDE,
    };

    const adapter = createClaudeCodeAdapter(agent, provider);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
    expect(adapter.capabilities.toolCalling).toBe(false);
  });
});
