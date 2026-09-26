import { describe, expect, it } from "vitest";
import type { SandboxRunResult, SandboxStepResult } from "@punch/shared";
import { compareRuns } from "./compare.js";

const step = (
  status: SandboxStepResult["status"],
  exitCode: number | null = status === "pass" ? 0 : 1,
): SandboxStepResult => ({
  status,
  exitCode,
  durationMs: 1,
  logTail: "",
});

function run(over: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return {
    install: step("pass"),
    build: step("pass"),
    test: step("pass"),
    counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
    failingTests: [],
    ...over,
  };
}

describe("compareRuns", () => {
  it("passes when nothing regressed", () => {
    expect(compareRuns(run(), run()).verdict).toBe("PASS");
  });

  it("fails and names new failing tests", () => {
    const c = compareRuns(
      run(),
      run({
        test: step("fail"),
        failingTests: ["b"],
        counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
      }),
    );
    expect(c.verdict).toBe("FAIL");
    expect(c.newFailures).toEqual(["b"]);
  });

  it("does not hold pre-existing failures against the upgrade", () => {
    const failing = {
      test: step("fail"),
      failingTests: ["old"],
      counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
    };
    const c = compareRuns(run(failing), run(failing));
    expect(c.verdict).toBe("PASS");
    expect(c.newFailures).toEqual([]);
  });

  it("reports fixed failures", () => {
    const c = compareRuns(run({ test: step("fail"), failingTests: ["old"] }), run());
    expect(c.verdict).toBe("PASS");
    expect(c.fixedFailures).toEqual(["old"]);
  });

  it("fails when candidate install fails", () => {
    expect(compareRuns(run(), run({ install: step("fail") })).verdict).toBe("FAIL");
  });

  it("fails when the build newly breaks, but not when it was already broken", () => {
    expect(compareRuns(run(), run({ build: step("fail") })).verdict).toBe("FAIL");
    expect(compareRuns(run({ build: step("fail") }), run({ build: step("fail") })).verdict).toBe(
      "PASS",
    );
  });

  it("fails on unattributable test failures", () => {
    const c = compareRuns(run(), run({ test: step("fail"), counts: null }));
    expect(c.verdict).toBe("FAIL");
  });

  it("is never PASS without tests", () => {
    const noTests = { test: step("skipped", null), counts: null };
    const c = compareRuns(run(noTests), run(noTests));
    expect(c.verdict).toBe("NOT_RUN");
    expect(c.note).toMatch(/no tests/);
  });

  it("treats a run that executed zero tests as no tests", () => {
    const zero = { counts: { total: 0, passed: 0, failed: 0, skipped: 0 } };
    expect(compareRuns(run(zero), run(zero)).verdict).toBe("NOT_RUN");
  });

  it("still fails a no-tests repo when install or build regress", () => {
    const noTests = { test: step("skipped", null), counts: null };
    expect(compareRuns(run(noTests), run({ ...noTests, build: step("fail") })).verdict).toBe(
      "FAIL",
    );
  });
});
