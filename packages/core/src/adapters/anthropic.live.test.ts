import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { collect, runInput } from "./anthropic.test-helpers.js";

const model = process.env.PUNCH_LIVE_ANTHROPIC_MODEL;

/** Opt-in: spends a few cents. Requires ANTHROPIC_API_KEY and PUNCH_LIVE_ANTHROPIC_MODEL. */
describe.skipIf(!process.env.ANTHROPIC_API_KEY || !model)("AnthropicAdapter (live)", () => {
  const adapter = new AnthropicAdapter({
    model: model ?? "",
    providerId: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    executeTool: async () => ({ latest: "4.17.21" }),
  });

  it("test() reaches the API", async () => {
    expect(await adapter.test()).toMatchObject({ ok: true });
  }, 60_000);

  it("completes a tiny subtask via write_result", async () => {
    const events = await collect(
      adapter.run(
        runInput({ task: "Look up lodash with npm_lookup, then write_result.", effort: "low" }),
      ),
    );
    expect(events.find((e) => e.type === "result")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ok" });
  }, 120_000);
});
