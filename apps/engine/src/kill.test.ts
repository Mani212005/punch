import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./cli.js";
import { killCommand } from "./kill.js";
import { runCommand } from "./run.js";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../../fixtures/runs/takeover");

describe("punch kill", () => {
  it("rejects an unknown slot and an unknown run", () => {
    expect(() => killCommand("r", "janitor")).toThrow(/unknown slot/);
    expect(() => killCommand("nope", "researcher", { runsDir: os.tmpdir() })).toThrow(/no run/);
  });

  it("is a real command with a --runs-dir option", () => {
    const help = buildProgram()
      .commands.find((c) => c.name() === "kill")!
      .helpInformation();
    expect(help).toContain("--runs-dir");
  });

  it("kills the running researcher of a live run and the run recovers", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-kill-"));
    const lines: string[] = [];
    let runId = "";
    let sent = false;
    const result = await runCommand(FIXTURE, {
      runsDir,
      // a stalled researcher never finishes on its own; only the operator's kill ends it
      chaos: ["stall:researcher"],
      log: (line) => {
        lines.push(line);
        const started = /^run (\S+) started/.exec(line);
        if (started) runId = started[1]!;
        if (!sent && line.includes("researcher opus started")) {
          sent = true;
          expect(killCommand(runId, "researcher", { runsDir, message: "stage lever" })).toContain(
            "kill requested",
          );
        }
      },
    });
    expect(result.status).toBe("completed");
    expect(lines.some((l) => l.includes("failed (operator_kill): stage lever"))).toBe(true);
    expect(lines.some((l) => l.includes("opus -> gemini"))).toBe(true);
    expect(lines.some((l) => l.includes("replaced in"))).toBe(true);
    fs.rmSync(runsDir, { recursive: true, force: true });
  });
});
