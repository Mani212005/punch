import type { TraceEvent } from "@punch/shared";
import { markdownTable } from "./render-md.js";

/** Measured per-run numbers for one bench repetition (plan.md A11). */
export interface BenchRunMetrics {
  runIndex: number;
  runId: string;
  status: string;
  completed: boolean;
  /** Measured wall-clock for the run, not an estimate. */
  durationMs: number;
  /** Measured spend from the last `budget.checked` event. */
  costUsd: number;
  stepsUsed: number;
  /** Successful takeovers (`slot.replaced`). */
  takeoverCount: number;
  detectionMsList: number[];
  /** Mean of `detectionMs` across `slot.replacing` events that carry it. */
  meanDetectionMs: number | null;
  takeoverMsList: number[];
  meanTakeoverMs: number | null;
}

export interface BenchSummary {
  target: string;
  runs: number;
  chaos: string[];
  completedRuns: number;
  completionRate: number;
  totalTakeovers: number;
  meanTakeoversPerRun: number;
  /** Mean detection-to-takeover time across all takeovers with a measured gap. */
  meanDetectionMs: number | null;
  meanTakeoverMs: number | null;
  meanCostUsd: number;
  meanLatencyMs: number;
  perRun: BenchRunMetrics[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Extracts measured cost, latency, completion and takeover numbers from a finished trace. */
export function collectBenchMetrics(
  events: TraceEvent[],
  opts: { runIndex: number; runId: string; durationMs: number },
): BenchRunMetrics {
  const finished = [...events].reverse().find((e) => e.kind === "run.finished");
  const status = finished?.kind === "run.finished" ? finished.status : "unknown";
  const budgets = events.filter((e) => e.kind === "budget.checked");
  const lastBudget = budgets[budgets.length - 1];
  const replacing = events.filter((e) => e.kind === "slot.replacing");
  const replaced = events.filter((e) => e.kind === "slot.replaced");
  const detectionMsList = replacing
    .filter((e) => e.kind === "slot.replacing" && e.detectionMs !== undefined)
    .map((e) => (e.kind === "slot.replacing" ? e.detectionMs! : 0));
  const takeoverMsList = replaced.map((e) => (e.kind === "slot.replaced" ? e.takeoverMs : 0));

  return {
    runIndex: opts.runIndex,
    runId: opts.runId,
    status,
    completed: status === "completed",
    durationMs: opts.durationMs,
    costUsd: lastBudget?.kind === "budget.checked" ? lastBudget.usd.used : 0,
    stepsUsed: lastBudget?.kind === "budget.checked" ? lastBudget.steps.used : 0,
    takeoverCount: replaced.length,
    detectionMsList,
    meanDetectionMs: mean(detectionMsList),
    takeoverMsList,
    meanTakeoverMs: mean(takeoverMsList),
  };
}

/** Aggregates per-run metrics into the bench summary. */
export function summarizeBench(
  target: string,
  chaos: string[],
  perRun: BenchRunMetrics[],
): BenchSummary {
  const completedRuns = perRun.filter((r) => r.completed).length;
  const allDetections = perRun.flatMap((r) => r.detectionMsList);
  const allTakeoverMs = perRun.flatMap((r) => r.takeoverMsList);
  return {
    target,
    runs: perRun.length,
    chaos,
    completedRuns,
    completionRate: perRun.length === 0 ? 0 : completedRuns / perRun.length,
    totalTakeovers: perRun.reduce((n, r) => n + r.takeoverCount, 0),
    meanTakeoversPerRun:
      perRun.length === 0 ? 0 : perRun.reduce((n, r) => n + r.takeoverCount, 0) / perRun.length,
    meanDetectionMs: mean(allDetections),
    meanTakeoverMs: mean(allTakeoverMs),
    meanCostUsd: mean(perRun.map((r) => r.costUsd)) ?? 0,
    meanLatencyMs: mean(perRun.map((r) => r.durationMs)) ?? 0,
    perRun,
  };
}

function fmtMean(ms: number | null): string {
  return ms === null ? "n/a" : `${Math.round(ms)}ms`;
}

/** One markdown table per run plus the aggregate, for the README and the CLI. */
export function renderBenchMarkdown(summary: BenchSummary): string {
  const lines = [
    `# Punch bench - ${summary.target}`,
    "",
    `- Runs: ${summary.runs}`,
    `- Chaos: ${summary.chaos.length ? summary.chaos.join(", ") : "none"}`,
    `- Task completion rate: ${(summary.completionRate * 100).toFixed(1)}% (${summary.completedRuns}/${summary.runs})`,
    `- Takeovers: ${summary.totalTakeovers} total, ${summary.meanTakeoversPerRun.toFixed(2)} mean per run`,
    `- Mean detection-to-takeover time: ${fmtMean(summary.meanDetectionMs)}`,
    `- Mean takeover time: ${fmtMean(summary.meanTakeoverMs)}`,
    `- Mean cost per run: $${summary.meanCostUsd.toFixed(4)} (measured)`,
    `- Mean latency per run: ${Math.round(summary.meanLatencyMs)}ms (measured)`,
    "",
    ...markdownTable(
      ["Run", "Status", "Latency", "Cost (USD)", "Steps", "Takeovers", "Mean detection"],
      summary.perRun.map((r) => [
        String(r.runIndex),
        r.status,
        `${r.durationMs}ms`,
        `$${r.costUsd.toFixed(4)}`,
        String(r.stepsUsed),
        String(r.takeoverCount),
        fmtMean(r.meanDetectionMs),
      ]),
    ),
  ];
  return lines.join("\n");
}
