import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEntry, AgentEvent, Provider } from "@punch/shared";
import { OpenCodeAdapter, createOpenCodeAdapter } from "./opencode.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../../../fixtures/cli");
const FAKE_OPENCODE = path.join(FIXTURES_DIR, "fake-opencode.js");

function testRunInput(overrides: Partial<AdapterRunInput> = {}): AdapterRunInput {
  return {
    system: "You are an OpenCode agent.",
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
    effort: "low",
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

describe("OpenCodeAdapter", () => {
  it("declares capabilities with toolCalling: false and streaming: true", () => {
    const adapter = new OpenCodeAdapter({
      model: "opencode/free",
      providerId: "opencode",
      binary: FAKE_OPENCODE,
    });
    expect(adapter.capabilities).toEqual({
      toolCalling: false,
      structuredOutput: false,
      streaming: true,
      effort: true,
    });
  });

  it("test() checks binary version", async () => {
    const adapter = new OpenCodeAdapter({
      model: "opencode/free",
      providerId: "opencode",
      binary: FAKE_OPENCODE,
    });
    const res = await adapter.test();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("1.18.32");
  });

  it("completes a run yielding heartbeats, text, opaque_output, result, and done", async () => {
    const adapter = new OpenCodeAdapter({
      model: "opencode/free",
      providerId: "opencode",
      binary: FAKE_OPENCODE,
    });
    const events = await collectEvents(adapter.run(testRunInput()));

    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "opaque_output")).toBe(true);

    const result = events.find((e) => e.type === "result");
    expect(result).toEqual({
      type: "result",
      output: { findings: [{ package: "express", latest: "4.19.2" }] },
    });

    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({ type: "done", status: "ok" });
  });

  it("handles malformed output with correction round", async () => {
    const adapter = new OpenCodeAdapter({
      model: "opencode/free",
      providerId: "opencode",
      binary: FAKE_OPENCODE,
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
      output: { findings: [{ package: "express", latest: "4.19.2" }] },
    });
    expect(events.find((e) => e.type === "done")).toEqual({ type: "done", status: "ok" });
  });

  it("createOpenCodeAdapter factory creates adapter from AgentEntry and Provider", () => {
    const agent: AgentEntry = {
      id: "opencode-agent",
      displayName: "OpenCode Free",
      providerId: "opencode-provider",
      model: "free-tier",
      costTier: "low",
      roles: ["researcher", "executor"],
      strengths: "Fast free model",
    };
    const provider: Provider = {
      id: "opencode-provider",
      kind: "opencode",
      binary: FAKE_OPENCODE,
    };

    const adapter = createOpenCodeAdapter(agent, provider);
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
    expect(adapter.capabilities.toolCalling).toBe(false);
  });
});
