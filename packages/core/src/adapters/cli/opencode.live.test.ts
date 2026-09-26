import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEvent } from "@punch/shared";
import { OpenCodeAdapter } from "./opencode.js";

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function liveRunInput(): AdapterRunInput {
  return {
    system: "You are a helpful assistant. Output only the requested JSON.",
    task: "Output a JSON object with status 'ok' and package 'punch'.",
    inputs: {},
    tools: [],
    resultSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        package: { type: "string" },
      },
      required: ["status", "package"],
    },
    effort: "low",
    maxTurns: 3,
    signal: new AbortController().signal,
  };
}

describe.skipIf(!process.env.PUNCH_LIVE_CLI)("OpenCodeAdapter (live smoke)", () => {
  const adapter = new OpenCodeAdapter({
    model: process.env.PUNCH_LIVE_OPENCODE_MODEL ?? "",
    providerId: "opencode",
  });

  it("test() checks opencode binary", async () => {
    const res = await adapter.test();
    expect(res.ok).toBe(true);
    expect(res.detail).toBeDefined();
  }, 30_000);

  it.skipIf(!process.env.PUNCH_LIVE_OPENCODE_MODEL)(
    "completes a minimal prompt with result schema validation",
    async () => {
      const events = await collect(adapter.run(liveRunInput()));
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      if (done && done.type === "done") {
        expect(done.status).toBe("ok");
      }
      expect(events.find((e) => e.type === "result")).toBeDefined();
    },
    120_000,
  );
});
