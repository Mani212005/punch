import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureJev, loadRunFixture } from "../run/fixture.js";
import { runLoop } from "../run/loop.js";
import { createDefaultAdapterRegistry } from "../run/registry.js";

/**
 * Opt-in live smoke for B3: one real cross-provider takeover.
 *
 * Skipped unless ANTHROPIC_API_KEY, PUNCH_LIVE_ANTHROPIC_MODEL and GEMINI_API_KEY are set.
 * The Anthropic researcher is crashed after its first real tool result and a real Gemini
 * standby finishes the subtask against the live advisory APIs. Spends a few cents.
 */
const ANTHROPIC_MODEL = process.env.PUNCH_LIVE_ANTHROPIC_MODEL;
const GEMINI_MODEL = process.env.PUNCH_LIVE_GEMINI_MODEL ?? "gemini-2.5-flash";
const HAS_KEYS =
  !!process.env.ANTHROPIC_API_KEY && !!ANTHROPIC_MODEL && !!process.env.GEMINI_API_KEY;

const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../fixtures/runs/takeover",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-cross-provider-live-"));

describe.skipIf(!HAS_KEYS)("B3 cross-provider takeover (live)", () => {
  it("a crashed Anthropic researcher is finished by a real Gemini standby", async () => {
    const fixture = await loadRunFixture(FIXTURE);
    for (const agent of fixture.config.agents) {
      if (agent.providerId === "anthropic") agent.model = ANTHROPIC_MODEL!;
      if (agent.providerId === "google") agent.model = GEMINI_MODEL;
    }
    const r = await runLoop({
      task: fixture.task,
      config: fixture.config,
      jev: createFixtureJev(fixture),
      adapters: createDefaultAdapterRegistry(),
      runsDir,
      toolTimeoutMs: 30_000,
      maxConcurrency: 1,
      killChannel: false,
      attemptTimeoutMs: 240_000,
      chaos: ["kill-after:researcher:1"],
    });
    expect(r.traceErrors).toEqual([]);
    const replacing = r.events.filter((e) => e.kind === "slot.replacing");
    expect(replacing.length).toBeGreaterThan(0);
    const byProvider = (agentId: string) =>
      fixture.config.agents.find((a) => a.id === agentId)?.providerId;
    for (const e of replacing) {
      if (byProvider(e.failedAgentId) === "anthropic") {
        expect(byProvider(e.replacementAgentId)).not.toBe("anthropic");
      }
    }
    expect(r.status).toBe("completed");
  }, 300_000);
});
