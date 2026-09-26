import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRunInput, AgentEvent } from "@punch/shared";
import { parseAgentChaos } from "../agent.js";
import {
  defaultBuildPrompt,
  defaultParseCliLine,
  extractJsonCandidate,
  runCliAdapter,
  testCliBinary,
} from "./runner.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../../../fixtures/cli");
const FAKE_CLAUDE = path.join(FIXTURES_DIR, "fake-claude.js");

function testRunInput(overrides: Partial<AdapterRunInput> = {}): AdapterRunInput {
  return {
    system: "You are a test agent.",
    task: "Check dependencies.",
    inputs: { previous: { key: "prev", data: "data" } as unknown as never },
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

describe("CLI Runner", () => {
  describe("extractJsonCandidate", () => {
    it("extracts direct JSON", () => {
      const res = extractJsonCandidate(
        '{"findings": [{"package": "lodash", "latest": "4.17.21"}]}',
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual({
          findings: [{ package: "lodash", latest: "4.17.21" }],
        });
      }
    });

    it("extracts JSON from markdown code block", () => {
      const text = `
Here is the result:
\`\`\`json
{
  "findings": [{"package": "lodash", "latest": "4.17.21"}]
}
\`\`\`
All done!`;
      const res = extractJsonCandidate(text);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual({
          findings: [{ package: "lodash", latest: "4.17.21" }],
        });
      }
    });

    it("extracts JSON from raw text containing braces", () => {
      const text =
        'Log output...\n{"findings": [{"package": "lodash", "latest": "4.17.21"}]}\nFinished.';
      const res = extractJsonCandidate(text);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual({
          findings: [{ package: "lodash", latest: "4.17.21" }],
        });
      }
    });

    it("returns error on empty or invalid text", () => {
      expect(extractJsonCandidate("").ok).toBe(false);
      expect(extractJsonCandidate("   ").ok).toBe(false);
      expect(extractJsonCandidate("This is not JSON").ok).toBe(false);
    });
  });

  describe("defaultBuildPrompt and defaultParseCliLine", () => {
    it("formats prompt with schema and inputs", () => {
      const prompt = defaultBuildPrompt(testRunInput());
      expect(prompt).toContain("<task>\nCheck dependencies.\n</task>");
      expect(prompt).toContain("<inputs>");
      expect(prompt).toContain("<result_schema>");
      expect(prompt).toContain("CRITICAL INSTRUCTION");
    });

    it("formats correction prompt when correction info is passed", () => {
      const prompt = defaultBuildPrompt(testRunInput(), {
        previousOutput: '{"findings": "wrong"}',
        error: "findings must be an array",
      });
      expect(prompt).toContain("[CORRECTION REQUIRED]");
      expect(prompt).toContain("findings must be an array");
      expect(prompt).toContain('{"findings": "wrong"}');
    });

    it("parses stream-json line shapes into events", () => {
      const textEv = defaultParseCliLine('{"type":"text","text":"hello world"}');
      expect(textEv).toEqual([{ type: "text", text: "hello world" }]);

      const deltaEv = defaultParseCliLine(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk"}}',
      );
      expect(deltaEv).toEqual([{ type: "text", text: "chunk" }]);

      const usageEv = defaultParseCliLine(
        '{"type":"usage","usage":{"input_tokens":100,"output_tokens":25}}',
      );
      expect(usageEv).toEqual([{ type: "usage", usage: { inputTokens: 100, outputTokens: 25 } }]);

      const toolEv = defaultParseCliLine(
        '{"type":"tool_use","name":"Bash","input":{"command":"ls"}}',
      );
      expect(toolEv[0]?.type).toBe("opaque_output");

      const plainLine = defaultParseCliLine("Just a plain log line");
      expect(plainLine).toEqual([{ type: "text", text: "Just a plain log line" }]);
    });

    it("parses the real opencode run --format json envelope", () => {
      const nestedText = defaultParseCliLine(
        '{"type":"text","timestamp":1790410203031,"part":{"type":"text","text":"hello world"}}',
      );
      expect(nestedText).toEqual([{ type: "text", text: "hello world" }]);

      const stepFinish = defaultParseCliLine(
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":25960,"output":15}}}',
      );
      expect(stepFinish).toEqual([
        { type: "usage", usage: { inputTokens: 25960, outputTokens: 15 } },
      ]);

      const stepStart = defaultParseCliLine('{"type":"step_start","part":{"type":"step-start"}}');
      expect(stepStart[0]?.type).toBe("opaque_output");
    });
  });

  describe("testCliBinary", () => {
    it("returns ok for working binary", async () => {
      const res = await testCliBinary(FAKE_CLAUDE, ["--version"]);
      expect(res.ok).toBe(true);
      expect(res.detail).toContain("2.1.281");
    });

    it("returns error for missing binary", async () => {
      const res = await testCliBinary("/non/existent/binary");
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("binary not found");
    });

    it("honors provider-down chaos", async () => {
      const chaos = parseAgentChaos(["provider-down:claude-provider"]);
      const res = await testCliBinary(FAKE_CLAUDE, ["--version"], {
        providerId: "claude-provider",
        chaos,
      });
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("503 provider unavailable");
    });
  });

  describe("runCliAdapter", () => {
    it("completes a run with streamed events, opaque output, and validated result", async () => {
      const input = testRunInput();
      const events = await collectEvents(
        runCliAdapter(input, {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      expect(events.some((e) => e.type === "heartbeat")).toBe(true);
      expect(events.some((e) => e.type === "text" && e.text.includes("Analyzing repository"))).toBe(
        true,
      );
      expect(events.some((e) => e.type === "opaque_output" && e.text.includes("Bash"))).toBe(true);
      expect(
        events.some((e) => e.type === "opaque_output" && e.text.includes("lodash@4.17.20")),
      ).toBe(true);

      const resultEvent = events.find((e) => e.type === "result");
      expect(resultEvent).toEqual({
        type: "result",
        output: { findings: [{ package: "lodash", latest: "4.17.21" }] },
      });

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toEqual({ type: "done", status: "ok" });
    });

    it("recovers from malformed output via correction round", async () => {
      const input = testRunInput();
      const events = await collectEvents(
        runCliAdapter(input, {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          env: { FAKE_CLI_MODE: "malformed_once" },
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      expect(
        events.some(
          (e) =>
            e.type === "opaque_output" &&
            e.text.includes("Result schema validation failed") &&
            e.text.includes("Starting correction round"),
        ),
      ).toBe(true);

      const resultEvent = events.find((e) => e.type === "result");
      expect(resultEvent).toEqual({
        type: "result",
        output: { findings: [{ package: "lodash", latest: "4.17.21" }] },
      });

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toEqual({ type: "done", status: "ok" });
    });

    it("fails terminally when output remains malformed after correction round", async () => {
      const input = testRunInput();
      const events = await collectEvents(
        runCliAdapter(input, {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          env: { FAKE_CLI_MODE: "malformed_always" },
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent?.type).toBe("done");
      if (doneEvent?.type === "done") {
        expect(doneEvent.status).toBe("error");
        expect(doneEvent.error).toContain("result failed schema validation twice");
      }
    });

    it("fails terminally on non-zero exit code", async () => {
      const input = testRunInput();
      const events = await collectEvents(
        runCliAdapter(input, {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          env: { FAKE_CLI_MODE: "error" },
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toEqual({
        type: "done",
        status: "error",
        error: "process exited with code 1: Error: authentication token expired",
      });
    });

    it("fails terminally on missing binary", async () => {
      const input = testRunInput();
      const events = await collectEvents(
        runCliAdapter(input, {
          binary: "/invalid/bin/punch-nonexistent",
          providerId: "claude",
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toEqual({
        type: "done",
        status: "error",
        error: "missing binary: /invalid/bin/punch-nonexistent",
      });
    });

    it("aborts when signal fires", async () => {
      const controller = new AbortController();
      const input = testRunInput({ signal: controller.signal });

      setTimeout(() => controller.abort(), 50);

      const events = await collectEvents(
        runCliAdapter(input, {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          env: { FAKE_CLI_MODE: "hang" },
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toEqual({ type: "done", status: "error", error: "aborted" });
    });

    it("honors chaos hooks: provider-down, garbage, and kill-after", async () => {
      // provider-down
      const chaosDown = parseAgentChaos(["provider-down:claude"]);
      const eventsDown = await collectEvents(
        runCliAdapter(testRunInput(), {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          chaos: chaosDown,
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );
      expect(eventsDown.find((e) => e.type === "done")).toEqual({
        type: "done",
        status: "error",
        error: "503 provider unavailable (chaos: provider-down:claude)",
      });

      // garbage chaos on researcher role
      const chaosGarbage = parseAgentChaos(["garbage:researcher"]);
      const eventsGarbage = await collectEvents(
        runCliAdapter(testRunInput({ role: "researcher" }), {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          chaos: chaosGarbage,
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );
      const doneGarbage = eventsGarbage.find((e) => e.type === "done");
      expect(doneGarbage?.type).toBe("done");
      if (doneGarbage?.type === "done") {
        expect(doneGarbage.status).toBe("error");
        expect(doneGarbage.error).toContain("result failed schema validation twice");
      }

      // kill-after chaos
      const chaosKill = parseAgentChaos(["kill-after:researcher:1"]);
      const eventsKill = await collectEvents(
        runCliAdapter(testRunInput({ role: "researcher" }), {
          binary: FAKE_CLAUDE,
          providerId: "claude",
          chaos: chaosKill,
          buildArgs: (prompt) => ["-p", prompt],
        }),
      );
      const doneKill = eventsKill.find((e) => e.type === "done");
      expect(doneKill).toEqual({
        type: "done",
        status: "error",
        error: "agent crashed after 1 turns (chaos: kill-after:researcher:1)",
      });
    });
  });
});
