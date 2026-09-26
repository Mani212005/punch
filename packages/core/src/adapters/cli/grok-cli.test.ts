import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEntry, AgentEvent, Provider } from "@punch/shared";
import { GrokCliAdapter, createGrokCliAdapter } from "./grok-cli.js";

function testRunInput(): AdapterRunInput {
  return {
    system: "You are a Grok agent.",
    task: "Audit dependencies.",
    inputs: {},
    tools: [],
    resultSchema: { type: "object" },
    effort: "low",
    maxTurns: 5,
    signal: new AbortController().signal,
  };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("GrokCliAdapter", () => {
  it("declares toolCalling: false and streaming: false", () => {
    const adapter = new GrokCliAdapter({
      model: "grok-2",
      providerId: "grok-cli",
    });
    expect(adapter.capabilities).toEqual({
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      effort: false,
    });
  });

  it("test() reports no subscription", async () => {
    const adapter = new GrokCliAdapter({
      model: "grok-2",
      providerId: "grok-cli",
    });
    const res = await adapter.test();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("grok-cli: no subscription");
  });

  it("run() yields done with error", async () => {
    const adapter = new GrokCliAdapter({
      model: "grok-2",
      providerId: "grok-cli",
    });
    const events = await collectEvents(adapter.run(testRunInput()));
    expect(events).toEqual([
      { type: "heartbeat" },
      { type: "done", status: "error", error: "grok-cli: no subscription" },
    ]);
  });

  it("createGrokCliAdapter creates instance", () => {
    const agent: AgentEntry = {
      id: "grok-agent",
      displayName: "Grok",
      providerId: "grok-provider",
      model: "grok-2",
      costTier: "high",
      roles: ["researcher"],
      strengths: "Fast",
    };
    const provider: Provider = {
      id: "grok-provider",
      kind: "grok-cli",
    };
    const adapter = createGrokCliAdapter(agent, provider);
    expect(adapter).toBeInstanceOf(GrokCliAdapter);
  });
});
