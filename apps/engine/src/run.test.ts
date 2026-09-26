import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./cli.js";
import { runCommand } from "./run.js";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../../fixtures/runs/clean");

describe("punch run <fixture>", () => {
  it("completes offline and writes the trace", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-cli-"));
    const lines: string[] = [];
    const result = await runCommand(FIXTURE, { runsDir, log: (l) => lines.push(l) });
    expect(result.status).toBe("completed");
    expect(fs.existsSync(path.join(runsDir, result.runId, "trace.jsonl"))).toBe(true);
    expect(lines.some((l) => l.startsWith("run finished: completed"))).toBe(true);
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it("applies --chaos and --unattended", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-cli-"));
    const result = await runCommand(FIXTURE, {
      runsDir,
      chaos: ["tool:osv_query:500"],
      unattended: true,
      log: () => {},
    });
    expect(result.status).toBe("degraded");
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it("registers the run options", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(["--config", "--chaos", "--unattended", "--budget-usd"]),
    );
  });
});
