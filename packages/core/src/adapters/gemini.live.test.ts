import { describe, expect, it } from "vitest";
import { GeminiAdapter } from "./gemini.js";
import { collect, runInput } from "./gemini.test-helpers.js";
import { WRITE_RESULT_TOOL } from "./gemini.js";

const HAS_KEY = !!process.env.GEMINI_API_KEY;

describe.runIf(HAS_KEY)("Gemini live test", () => {
  it("makes a real generation with write_result", async () => {
    const a = new GeminiAdapter({
      model: "gemini-2.5-flash",
      providerId: "gemini",
      apiKeyEnv: "GEMINI_API_KEY",
    });

    const test = await a.test();
    expect(test.ok).toBe(true);

    const executor = async ({ name, input }: { name: string; input: Record<string, unknown> }) => {
      if (name === "npm_lookup") return { name: (input as Record<string, unknown>).name, latest: "4.17.21" };
      throw new Error(`unknown tool ${name}`);
    };

    a["options"].executeTool = executor;

    const events = await collect(a.run(runInput({ effort: "medium" })));
    const done = events.find((e) => e.type === "done");
    
    expect(done).toMatchObject({ status: "ok" });
    const result = events.find((e) => e.type === "result") as { output: { findings: { package: string, latest: string }[] } };
    expect(result.output.findings[0]).toMatchObject({ package: "lodash", latest: "4.17.21" });
    
    const tools = events.filter((e) => e.type === "tool_call" && e.tool !== WRITE_RESULT_TOOL);
    expect(tools.length).toBeGreaterThan(0);
  }, 30000); // 30s timeout
});
