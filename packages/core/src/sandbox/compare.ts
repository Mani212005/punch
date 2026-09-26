import type { SandboxRunResult, SandboxVerdict } from "@punch/shared";

export interface Comparison {
  verdict: SandboxVerdict;
  newFailures: string[];
  fixedFailures: string[];
  note: string;
}

/**
 * Compare a baseline run with a candidate (post-upgrade) run. Pre-existing failures are not
 * held against the upgrade; only new ones are. A repo without tests can never earn PASS: the
 * best it gets is NOT_RUN, because install and build alone do not show behavior is preserved.
 */
export function compareRuns(baseline: SandboxRunResult, candidate: SandboxRunResult): Comparison {
  const baseNames = new Set(baseline.failingTests);
  const candNames = new Set(candidate.failingTests);
  const newFailures = [...candNames].filter((n) => !baseNames.has(n));
  const fixedFailures = [...baseNames].filter((n) => !candNames.has(n));
  const notes: string[] = [];

  if (candidate.install.status !== "pass") {
    return {
      verdict: "FAIL",
      newFailures,
      fixedFailures,
      note: "candidate install failed after applying the upgrade",
    };
  }

  let regressed = false;
  if (candidate.build.status === "fail" && baseline.build.status !== "fail") {
    regressed = true;
    notes.push("build passed before the upgrade and fails after it");
  }

  if (candidate.test.status === "fail") {
    if (
      candidate.failingTests.length > 0 &&
      baseline.test.status === "fail" &&
      baseNames.size > 0
    ) {
      if (newFailures.length > 0) {
        regressed = true;
        notes.push(`${newFailures.length} new failing test(s)`);
      } else {
        notes.push("all remaining failures already failed before the upgrade");
      }
    } else if (baseline.test.status !== "fail") {
      regressed = true;
      notes.push(
        newFailures.length > 0
          ? `${newFailures.length} new failing test(s)`
          : "test command passed before the upgrade and fails after it",
      );
    } else if (
      candidate.counts &&
      baseline.counts &&
      candidate.counts.failed <= baseline.counts.failed &&
      candidate.failingTests.length === 0
    ) {
      notes.push("failure count did not increase over the pre-existing failures");
    } else {
      regressed = true;
      notes.push(
        "tests fail after the upgrade and the failures cannot be shown to be pre-existing",
      );
    }
  }

  if (regressed) {
    return { verdict: "FAIL", newFailures, fixedFailures, note: notes.join("; ") };
  }

  const noTests =
    candidate.test.status === "skipped" ||
    candidate.test.status === "not_run" ||
    (candidate.counts !== null && candidate.counts.total === 0);
  if (noTests) {
    notes.unshift(
      "no tests: install and build cannot show the upgrade is safe, so this is not a PASS",
    );
    return { verdict: "NOT_RUN", newFailures, fixedFailures, note: notes.join("; ") };
  }

  return { verdict: "PASS", newFailures, fixedFailures, note: notes.join("; ") };
}
