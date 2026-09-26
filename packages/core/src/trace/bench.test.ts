import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureRunOptions, loadRunFixture } from "../run/fixture.js";
import { runLoop } from "../run/loop.js";
import { collectBenchMetrics, renderBenchMarkdown, summarizeBench } from "./bench.js";

const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../fixtures/runs/takeover",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-bench-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

describe("bench over the offline fixture with a takeover chaos profile (A11)", () => {
  it("measures cost and latency per run, completion rate, takeovers and mean detection time", async () => {
    const perRun = [];
    for (let i = 0; i < 2; i++) {
      const fixture = await loadRunFixture(FIXTURE);
      const start = Date.now();
      const result = await runLoop(
        fixtureRunOptions(fixture, {
          runsDir,
          toolTimeoutMs: 2000,
          maxConcurrency: 1,
          killChannel: false,
          chaos: ["kill-after:researcher:2"],
        }),
      );
      const durationMs = Date.now() - start;
      expect(result.traceErrors).toEqual([]);
      perRun.push(
        collectBenchMetrics(result.events, { runIndex: i + 1, runId: result.runId, durationMs }),
      );
    }

    const summary = summarizeBench(FIXTURE, ["kill-after:researcher:2"], perRun);
    expect(summary.runs).toBe(2);
    expect(summary.completedRuns).toBe(2);
    expect(summary.completionRate).toBe(1);
    // one kill-after takeover per run
    expect(summary.totalTakeovers).toBeGreaterThanOrEqual(2);
    expect(summary.meanDetectionMs).not.toBeNull();
    expect(summary.meanDetectionMs!).toBeGreaterThanOrEqual(0);
    // measured, not estimated: real wall-clock and metered model cost
    for (const r of summary.perRun) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.costUsd).toBeGreaterThan(0);
      expect(r.completed).toBe(true);
    }
    expect(summary.meanCostUsd).toBeGreaterThan(0);

    // JSON and markdown table shapes
    const json = JSON.parse(JSON.stringify(summary));
    expect(json.perRun).toHaveLength(2);
    expect(json.meanDetectionMs).not.toBeNull();
    const md = renderBenchMarkdown(summary);
    expect(md).toContain("| Run |");
    expect(md).toContain("Mean detection");
    expect(md).toContain("Task completion rate: 100.0%");
    expect(md).toContain("Mean detection-to-takeover time:");
  });
});
