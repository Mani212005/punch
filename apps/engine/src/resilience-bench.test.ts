import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertEvidencePreserved,
  renderResilienceMarkdown,
  renderResilienceSummary,
} from "@punch/core";
import { buildProgram } from "./cli.js";
import { FAILURE_MODES, resilienceBench } from "./resilience-bench.js";

const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../fixtures/runs/investigation",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-resilience-test-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

describe("punch bench --resilience (E7)", () => {
  it("injects all eight failure modes, recovers every failed agent and loses no evidence", async () => {
    const summary = await resilienceBench(FIXTURE, { runsDir, runs: 16 });

    expect(summary.investigations).toBe(16);
    expect(summary.byMode.map((m) => m.mode)).toEqual(FAILURE_MODES.map((m) => m.id));
    expect(summary.byMode.every((m) => m.runs === 2)).toBe(true);

    // Every run finished with a report; none crashed or aborted.
    expect(summary.perRun.every((r) => r.completed || r.degraded)).toBe(true);
    expect(summary.completionRate).toBeGreaterThanOrEqual(0.75);

    // Takeover: every mode that fails an agent produced a takeover, and none was left unrecovered.
    const mode = (id: string) => summary.byMode.find((m) => m.mode === id)!;
    for (const id of [
      "crash",
      "timeout",
      "malformed",
      "hallucinated",
      "rate-limit",
      "operator-kill",
    ]) {
      expect(mode(id).agentFailures, id).toBeGreaterThan(0);
      expect(mode(id).recoveries, id).toBe(mode(id).agentFailures);
    }
    expect(mode("critic-rejection").recoveries).toBeGreaterThan(0);
    expect(summary.takeoverSuccessRate).toBe(1);
    expect(summary.exhausted).toBe(0);
    expect(summary.meanTakeoverMs).not.toBeNull();

    // Evidence preservation is 100% across takeovers, and there were results to preserve.
    expect(summary.contextExpected).toBeGreaterThan(0);
    expect(summary.contextPreserved).toBe(summary.contextExpected);
    expect(summary.contextLostPct).toBe(0);
    expect(() => assertEvidencePreserved(summary)).not.toThrow();

    // The remaining section-11 metrics are measured, not defaulted.
    expect(summary.criticRejections).toBeGreaterThan(0);
    expect(summary.criticRejectionRate).toBeGreaterThan(0);
    expect(mode("tool-failure").completed).toBe(0); // degraded: the report flags unknowns
    expect(summary.toolFaults).toBeGreaterThan(0);
    expect(summary.totalLatencyMs).toBeGreaterThan(0);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.approvalsRequested).toBe(16);
    expect(summary.approvalRate).toBe(1);

    const text = renderResilienceSummary(summary);
    expect(text).toContain("16 investigations");
    expect(text).toContain(`Agent failures injected: ${summary.agentFailures}`);
    expect(text).toContain(`Successful recoveries: ${summary.recoveries}`);
    expect(text).toContain("Context lost: 0.0%");
    expect(text).toContain(`Final task completion: ${summary.completedRuns}/16`);
    const md = renderResilienceMarkdown(summary);
    for (const label of [
      "Task completion rate",
      "Agent failure rate",
      "Takeover success rate",
      "Takeover latency",
      "Evidence preservation: 100.0%",
      "Critic rejection rate",
      "Tool failure recovery",
      "Total latency",
      "Total cost",
      "Human approval rate",
    ]) {
      expect(md).toContain(label);
    }
  }, 120000);

  it("counts a denial in the human approval rate", async () => {
    const summary = await resilienceBench(FIXTURE, {
      runsDir,
      modes: ["crash"],
      runs: 4,
      approve: (i) => i % 2 === 0,
    });
    expect(summary.approvalsRequested).toBe(4);
    expect(summary.approvalsGranted).toBe(2);
    expect(summary.approvalRate).toBe(0.5);
  }, 60000);

  it("rejects too few runs to cover the modes and unknown modes", async () => {
    await expect(resilienceBench(FIXTURE, { runsDir, runs: 3 })).rejects.toThrow(
      /at least 8 to cover every selected failure mode/,
    );
    await expect(resilienceBench(FIXTURE, { runsDir, modes: ["nope"] })).rejects.toThrow(
      /unknown failure mode "nope"/,
    );
  });

  it("is reachable from the bench command", () => {
    const bench = buildProgram().commands.find((c) => c.name() === "bench")!;
    expect(bench.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--resilience", "--modes"]),
    );
  });
});
