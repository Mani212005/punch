import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderBenchMarkdown } from "@punch/core";
import { benchCommand } from "./bench.js";
import { buildProgram } from "./cli.js";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../../fixtures/runs/takeover");

describe("punch bench <fixture>", () => {
  it("runs twice with a takeover chaos profile and reports measured numbers", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-cli-bench-"));
    const summary = await benchCommand(FIXTURE, {
      runs: 2,
      chaos: ["kill-after:researcher:2"],
      runsDir,
      log: () => {},
    });
    expect(summary.runs).toBe(2);
    expect(summary.completionRate).toBe(1);
    expect(summary.totalTakeovers).toBeGreaterThanOrEqual(2);
    expect(summary.meanDetectionMs).not.toBeNull();
    expect(summary.meanCostUsd).toBeGreaterThan(0);
    const md = renderBenchMarkdown(summary);
    expect(md).toContain("| Run |");
    expect(md).toContain("Mean detection");
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it("rejects --runs 0", async () => {
    await expect(benchCommand(FIXTURE, { runs: 0 })).rejects.toThrow(
      /--runs must be a positive integer/,
    );
  });

  it("registers the bench subcommand in help", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("bench");
  });
});
