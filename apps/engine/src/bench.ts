import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectBenchMetrics, summarizeBench, type BenchSummary } from "@punch/core";
import { runCommand } from "./run.js";

export interface BenchCommandOptions {
  runs?: number;
  chaos?: string[];
  config?: string;
  runsDir?: string;
  unattended?: boolean;
  budgetUsd?: number;
  log?: (line: string) => void;
}

/**
 * `punch bench <fixture|repo> --runs N [--chaos profile]` (plan.md A11).
 * Runs the target repeatedly and reports measured cost and latency per run,
 * task completion rate, takeover count and mean detection-to-takeover time.
 */
export async function benchCommand(
  target: string,
  options: BenchCommandOptions = {},
): Promise<BenchSummary> {
  const total = options.runs ?? 3;
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`punch bench: --runs must be a positive integer, got ${options.runs}`);
  }
  const chaos = options.chaos ?? [];
  const runsDir = options.runsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "punch-bench-"));
  const log = options.log ?? (() => {});

  const perRun: BenchSummary["perRun"] = [];
  for (let i = 0; i < total; i++) {
    const start = Date.now();
    const result = await runCommand(target, {
      config: options.config,
      chaos,
      unattended: options.unattended,
      budgetUsd: options.budgetUsd,
      runsDir,
      log: () => {},
    });
    const durationMs = Date.now() - start;
    perRun.push(
      collectBenchMetrics(result.events, { runIndex: i + 1, runId: result.runId, durationMs }),
    );
    log(`bench run ${i + 1}/${total}: ${result.status} in ${durationMs}ms`);
  }
  return summarizeBench(target, chaos, perRun);
}
