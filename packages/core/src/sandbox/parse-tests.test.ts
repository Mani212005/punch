import { describe, expect, it } from "vitest";
import { parseTestOutput } from "./parse-tests.js";

describe("parseTestOutput", () => {
  it("parses vitest counts and failing names", () => {
    const out = [
      " ❯ src/a.test.ts (2 tests | 1 failed)",
      "   × adds > handles negatives",
      " FAIL  src/a.test.ts > adds > handles negatives",
      "AssertionError: expected 1 to be 2",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 1 passed (2)",
    ].join("\n");
    expect(parseTestOutput(out)).toEqual({
      counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
      failingTests: ["src/a.test.ts > adds > handles negatives"],
    });
  });

  it("parses jest and strips ANSI", () => {
    const out = [
      "\u001b[31m  ● math › subtracts\u001b[0m",
      "  ● Console",
      "Tests:       1 failed, 2 passed, 3 total",
    ].join("\n");
    expect(parseTestOutput(out)).toEqual({
      counts: { total: 3, passed: 2, failed: 1, skipped: 0 },
      failingTests: ["math › subtracts"],
    });
  });

  it("parses node:test spec output", () => {
    const out = [
      "✔ greets by name (0.5ms)",
      "✖ greets the world (1.2ms)",
      "ℹ tests 2",
      "ℹ pass 1",
      "ℹ fail 1",
      "ℹ skipped 0",
      "✖ failing tests:",
      "✖ greets the world (1.2ms)",
    ].join("\n");
    expect(parseTestOutput(out)).toEqual({
      counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
      failingTests: ["greets the world"],
    });
  });

  it("parses TAP output", () => {
    const out = ["ok 1 - a", "not ok 2 - b # time=1ms", "# tests 2", "# pass 1", "# fail 1"].join(
      "\n",
    );
    expect(parseTestOutput(out).failingTests).toEqual(["b"]);
    expect(parseTestOutput(out).counts).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it("parses mocha multi-line failure titles", () => {
    const out = [
      "  2 passing (5ms)",
      "  1 failing",
      "",
      "  1) Array",
      "       #indexOf()",
      "         should return -1:",
      "     AssertionError: boom",
    ].join("\n");
    const parsed = parseTestOutput(out);
    expect(parsed.counts).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(parsed.failingTests).toEqual(["Array #indexOf() should return -1"]);
  });

  it("never invents numbers for unknown formats", () => {
    expect(parseTestOutput("something else entirely")).toEqual({ counts: null, failingTests: [] });
  });
});
