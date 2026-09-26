import type { TestCounts } from "@punch/shared";

export interface ParsedTests {
  counts: TestCounts | null;
  failingTests: string[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const num = (m: RegExpMatchArray | null, i = 1): number => (m ? Number(m[i]) : 0);

function unique(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function parseVitest(text: string): ParsedTests | null {
  const line = text.match(/^\s*Tests\s+(.*\(\d+\))\s*$/m);
  if (!line) return null;
  const body = line[1]!;
  const total = num(body.match(/\((\d+)\)/));
  const failed = num(body.match(/(\d+) failed/));
  const skipped = num(body.match(/(\d+) (?:skipped|todo)/));
  const passed = num(body.match(/(\d+) passed/));
  const failing = [...text.matchAll(/^\s*FAIL\s+(\S.*? > .+?)\s*$/gm)].map((m) => m[1]!);
  return { counts: { total, passed, failed, skipped }, failingTests: unique(failing) };
}

function parseJest(text: string): ParsedTests | null {
  const line = text.match(/^Tests:\s+(.*\d+ total)\s*$/m);
  if (!line) return null;
  const body = line[1]!;
  const failing = [...text.matchAll(/^\s*● (?!Console\b)(.+?)\s*$/gm)].map((m) => m[1]!);
  return {
    counts: {
      total: num(body.match(/(\d+) total/)),
      passed: num(body.match(/(\d+) passed/)),
      failed: num(body.match(/(\d+) failed/)),
      skipped: num(body.match(/(\d+) (?:skipped|todo)/)),
    },
    failingTests: unique(failing),
  };
}

/** node:test (spec or TAP reporter). */
function parseNodeTest(text: string): ParsedTests | null {
  const spec = text.match(/^ℹ tests (\d+)\s*$/m);
  const tap = text.match(/^# tests (\d+)\s*$/m);
  const total = spec ?? tap;
  if (!total) return null;
  const prefix = spec ? "ℹ" : "#";
  const field = (name: string) =>
    num(text.match(new RegExp(`^${prefix} ${name} (\\d+)\\s*$`, "m")));
  const failing = spec
    ? [...text.matchAll(/^\s*✖ (.+?)(?: \([\d.]+ms\))?\s*$/gm)]
        .map((m) => m[1]!)
        .filter((name) => !/^failing tests:?$/.test(name))
    : [...text.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+# .*)?$/gm)].map((m) => m[1]!);
  return {
    counts: {
      total: Number(total[1]),
      passed: field("pass"),
      failed: field("fail"),
      skipped: field("skipped"),
    },
    failingTests: unique(failing),
  };
}

function parseMocha(text: string): ParsedTests | null {
  const passing = text.match(/^\s*(\d+) passing/m);
  const failing = text.match(/^\s*(\d+) failing/m);
  if (!passing && !failing) return null;
  const passed = num(passing);
  const failed = num(failing);
  const skipped = num(text.match(/^\s*(\d+) pending/m));
  const names: string[] = [];
  const idx = text.search(/^\s*\d+ failing/m);
  if (idx >= 0) {
    const lines = text.slice(idx).split("\n").slice(1);
    for (let i = 0; i < lines.length; i++) {
      const start = lines[i]!.match(/^\s*\d+\) (.*)$/);
      if (!start) continue;
      const parts = [start[1]!.trim()];
      while (
        !parts[parts.length - 1]!.endsWith(":") &&
        i + 1 < lines.length &&
        lines[i + 1]!.trim()
      ) {
        parts.push(lines[++i]!.trim());
      }
      names.push(parts.join(" ").replace(/:$/, ""));
    }
  }
  return {
    counts: { total: passed + failed + skipped, passed, failed, skipped },
    failingTests: unique(names),
  };
}

/**
 * Best-effort extraction of test counts and failing test names from a runner's output
 * (vitest, jest, node:test, mocha). Unknown formats yield null counts and no names; callers
 * then fall back to the exit code and never invent numbers.
 */
export function parseTestOutput(output: string): ParsedTests {
  const text = output.replace(ANSI, "");
  return (
    parseVitest(text) ??
    parseJest(text) ??
    parseNodeTest(text) ??
    parseMocha(text) ?? { counts: null, failingTests: [] }
  );
}
