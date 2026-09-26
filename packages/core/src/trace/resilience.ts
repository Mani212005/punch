import type { TraceEvent } from "@punch/shared";
import { markdownTable } from "./render-md.js";

/**
 * Resilience metrics (plan.md E7, addendum section 11), measured from finished traces. Nothing
 * here is estimated: every number is counted from trace events or the wall clock.
 */

/** One investigation's trace plus the failure mode that was injected into it. */
export interface ResilienceRunInput {
  runIndex: number;
  runId: string;
  /** Failure mode injected into this run, or `none` for a control run. */
  mode: string;
  events: TraceEvent[];
  durationMs: number;
}

export interface ResilienceRunMetrics {
  runIndex: number;
  runId: string;
  mode: string;
  status: string;
  completed: boolean;
  /** Finished with a report that flags unknowns (a step degraded) rather than failing. */
  degraded: boolean;
  durationMs: number;
  costUsd: number;
  /** Agent failures: `slot.failed` plus `slot.rejected` (a quality failure), per slot and subtask. */
  agentFailures: number;
  /** Failures followed by `slot.replaced` for the same slot and subtask. */
  recoveries: number;
  exhausted: number;
  takeoverMsList: number[];
  detectionMsList: number[];
  /** Successful, uncached tool results the failed agents produced before each takeover. */
  contextExpected: number;
  /** Of those, how many the handoffs carried to the replacement. */
  contextPreserved: number;
  filesRecovered: number;
  evidenceRecordsRecovered: number;
  criticVerdicts: number;
  criticRejections: number;
  /** Tool calls that needed a retry or came back failed. */
  toolFaults: number;
  /** Faults that ended in a successful result after retry, or a fallback source. */
  toolRecovered: number;
  /** Faults absorbed as degraded evidence (no takeover, run continued). */
  toolDegraded: number;
  approvalsRequested: number;
  approvalsGranted: number;
}

export interface ResilienceModeRow {
  mode: string;
  runs: number;
  completed: number;
  agentFailures: number;
  recoveries: number;
}

export interface ResilienceSummary {
  target: string;
  investigations: number;
  completedRuns: number;
  /** Runs that finished degraded: a report was produced with unknowns flagged. */
  degradedRuns: number;
  completionRate: number;
  agentFailures: number;
  recoveries: number;
  exhausted: number;
  /** Failed slots per investigation, over all slots that ran. */
  agentFailureRate: number;
  takeoverSuccessRate: number | null;
  meanTakeoverMs: number | null;
  meanDetectionMs: number | null;
  maxTakeoverMs: number | null;
  contextExpected: number;
  contextPreserved: number;
  /** Percentage of pre-takeover tool results that did not reach the replacement. */
  contextLostPct: number;
  filesRecovered: number;
  evidenceRecordsRecovered: number;
  criticVerdicts: number;
  criticRejections: number;
  criticRejectionRate: number | null;
  toolFaults: number;
  toolRecovered: number;
  toolDegraded: number;
  toolRecoveryRate: number | null;
  meanLatencyMs: number;
  totalLatencyMs: number;
  meanCostUsd: number;
  totalCostUsd: number;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalRate: number | null;
  byMode: ResilienceModeRow[];
  perRun: ResilienceRunMetrics[];
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

type Of<K extends TraceEvent["kind"]> = Extract<TraceEvent, { kind: K }>;

const slotKey = (role: string, subtaskId: string | undefined): string =>
  `${role}/${subtaskId ?? ""}`;

/** Extracts the section-11 numbers from one finished trace. */
export function collectResilienceMetrics(input: ResilienceRunInput): ResilienceRunMetrics {
  const { events } = input;
  const of = <K extends TraceEvent["kind"]>(kind: K): Of<K>[] =>
    events.filter((e): e is Of<K> => e.kind === kind);

  const finished = [...events]
    .reverse()
    .find((e): e is Of<"run.finished"> => e.kind === "run.finished");
  const status = finished?.status ?? "unknown";
  const budgets = of("budget.checked");
  const lastBudget = budgets[budgets.length - 1];

  // Agent failures and recoveries. A failure counts when the supervisor went on to attempt a
  // takeover (replacing or exhausted); a rejection routed to a targeted replan is critic work, not
  // a failed agent.
  const replaced = of("slot.replaced");
  const replacing = of("slot.replacing");
  let agentFailures = 0;
  let recoveries = 0;
  events.forEach((e, at) => {
    if (e.kind !== "slot.failed" && e.kind !== "slot.rejected") return;
    const key = slotKey(e.role, e.subtaskId);
    const next = events.slice(at + 1).find((n) => {
      if (n.kind === "slot.replacing" || n.kind === "slot.exhausted") {
        return slotKey(n.role, n.subtaskId) === key;
      }
      return n.kind === "replan.triggered" && n.subtaskId === e.subtaskId;
    });
    if (next?.kind !== "slot.replacing" && next?.kind !== "slot.exhausted") return;
    agentFailures += 1;
    if (
      next.kind === "slot.replacing" &&
      replaced.some((r) => r.seq > next.seq && slotKey(r.role, r.subtaskId) === key)
    ) {
      recoveries += 1;
    }
  });

  // Evidence preservation: what the failed agents had gathered vs what each handoff carried.
  const callSubtask = new Map<string, { role: string; subtaskId?: string; key: string }>();
  for (const e of of("tool.called")) {
    callSubtask.set(e.callId, {
      role: e.role,
      ...(e.subtaskId !== undefined ? { subtaskId: e.subtaskId } : {}),
      key: `${e.tool}:${JSON.stringify(e.input)}`,
    });
  }
  let contextExpected = 0;
  let contextPreserved = 0;
  let filesRecovered = 0;
  let evidenceRecordsRecovered = 0;
  for (const e of replacing) {
    const gathered = new Set<string>();
    for (const r of events) {
      if (r.seq >= e.seq) break;
      if (r.kind !== "tool.result" || !r.ok || r.cached) continue;
      const call = callSubtask.get(r.callId);
      if (call && call.role === e.role && call.subtaskId === e.subtaskId) gathered.add(call.key);
    }
    contextExpected += gathered.size;
    contextPreserved += Math.min(gathered.size, e.handoff.cachedResultCount);
    filesRecovered += e.handoff.filesInspectedCount ?? 0;
    evidenceRecordsRecovered += e.handoff.evidenceRecordCount ?? 0;
  }

  // Tool failure recovery.
  const results = of("tool.result");
  const fallbackTools = new Set(of("fallback.used").map((f) => f.tool));
  const faults = results.filter((r) => !r.cached && (!r.ok || r.retries > 0));
  const toolRecovered = faults.filter((r) => r.ok || fallbackTools.has(r.tool)).length;
  const toolDegraded = faults.length - toolRecovered;

  const verdicts = of("critic.verdict");
  const requested = of("approval.requested");
  const granted = of("approval.granted");

  return {
    runIndex: input.runIndex,
    runId: input.runId,
    mode: input.mode,
    status,
    completed: status === "completed",
    degraded: status === "degraded",
    durationMs: input.durationMs,
    costUsd: lastBudget?.usd.used ?? 0,
    agentFailures,
    recoveries,
    exhausted: of("slot.exhausted").length,
    takeoverMsList: replaced.map((e) => e.takeoverMs),
    detectionMsList: replacing.flatMap((e) => (e.detectionMs === undefined ? [] : [e.detectionMs])),
    contextExpected,
    contextPreserved,
    filesRecovered,
    evidenceRecordsRecovered,
    criticVerdicts: verdicts.length,
    criticRejections: verdicts.filter((v) => v.verdict === "rejected").length,
    toolFaults: faults.length,
    toolRecovered,
    toolDegraded,
    approvalsRequested: requested.length,
    approvalsGranted: granted.length,
  };
}

export function summarizeResilience(
  target: string,
  perRun: ResilienceRunMetrics[],
): ResilienceSummary {
  const completedRuns = perRun.filter((r) => r.completed).length;
  const agentFailures = sum(perRun.map((r) => r.agentFailures));
  const recoveries = sum(perRun.map((r) => r.recoveries));
  const takeoverMs = perRun.flatMap((r) => r.takeoverMsList);
  const contextExpected = sum(perRun.map((r) => r.contextExpected));
  const contextPreserved = sum(perRun.map((r) => r.contextPreserved));
  const criticVerdicts = sum(perRun.map((r) => r.criticVerdicts));
  const criticRejections = sum(perRun.map((r) => r.criticRejections));
  const toolFaults = sum(perRun.map((r) => r.toolFaults));
  const toolRecovered = sum(perRun.map((r) => r.toolRecovered));
  const approvalsRequested = sum(perRun.map((r) => r.approvalsRequested));
  const approvalsGranted = sum(perRun.map((r) => r.approvalsGranted));
  const modes = [...new Set(perRun.map((r) => r.mode))];

  return {
    target,
    investigations: perRun.length,
    completedRuns,
    degradedRuns: perRun.filter((r) => r.degraded).length,
    completionRate: perRun.length === 0 ? 0 : completedRuns / perRun.length,
    agentFailures,
    recoveries,
    exhausted: sum(perRun.map((r) => r.exhausted)),
    agentFailureRate: perRun.length === 0 ? 0 : agentFailures / perRun.length,
    takeoverSuccessRate: ratio(recoveries, agentFailures),
    meanTakeoverMs: mean(takeoverMs),
    meanDetectionMs: mean(perRun.flatMap((r) => r.detectionMsList)),
    maxTakeoverMs: takeoverMs.length ? Math.max(...takeoverMs) : null,
    contextExpected,
    contextPreserved,
    contextLostPct:
      contextExpected === 0 ? 0 : ((contextExpected - contextPreserved) / contextExpected) * 100,
    filesRecovered: sum(perRun.map((r) => r.filesRecovered)),
    evidenceRecordsRecovered: sum(perRun.map((r) => r.evidenceRecordsRecovered)),
    criticVerdicts,
    criticRejections,
    criticRejectionRate: ratio(criticRejections, criticVerdicts),
    toolFaults,
    toolRecovered,
    toolDegraded: sum(perRun.map((r) => r.toolDegraded)),
    toolRecoveryRate: ratio(toolRecovered, toolFaults),
    meanLatencyMs: mean(perRun.map((r) => r.durationMs)) ?? 0,
    totalLatencyMs: sum(perRun.map((r) => r.durationMs)),
    meanCostUsd: mean(perRun.map((r) => r.costUsd)) ?? 0,
    totalCostUsd: sum(perRun.map((r) => r.costUsd)),
    approvalsRequested,
    approvalsGranted,
    approvalRate: ratio(approvalsGranted, approvalsRequested),
    byMode: modes.map((mode) => {
      const rows = perRun.filter((r) => r.mode === mode);
      return {
        mode,
        runs: rows.length,
        completed: rows.filter((r) => r.completed).length,
        agentFailures: sum(rows.map((r) => r.agentFailures)),
        recoveries: sum(rows.map((r) => r.recoveries)),
      };
    }),
    perRun,
  };
}

/**
 * The addendum's evidence-preservation guarantee: no takeover loses context. Throws with the
 * shortfall when the handoffs carried less than the failed agents had gathered.
 */
export function assertEvidencePreserved(summary: ResilienceSummary): void {
  if (summary.contextPreserved !== summary.contextExpected) {
    const lost = summary.contextExpected - summary.contextPreserved;
    throw new Error(
      `evidence preservation is ${(100 - summary.contextLostPct).toFixed(1)}%, not 100%: ` +
        `${lost} of ${summary.contextExpected} tool results were lost across takeovers`,
    );
  }
}

const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const ms = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v)}ms`);

/** The addendum section 11 example, filled with measured numbers. */
export function renderResilienceSummary(summary: ResilienceSummary): string {
  const s = summary;
  return [
    `${s.investigations} investigations`,
    "",
    `Agent failures injected: ${s.agentFailures}`,
    `Successful recoveries: ${s.recoveries}`,
    `Average takeover: ${ms(s.meanTakeoverMs)}`,
    `Context lost: ${s.contextLostPct.toFixed(1)}%`,
    `Final task completion: ${s.completedRuns}/${s.investigations}`,
  ].join("\n");
}

/** Every section 11 metric plus the per-mode table, as Markdown for the CLI and the README. */
export function renderResilienceMarkdown(summary: ResilienceSummary): string {
  const s = summary;
  return [
    `# Punch resilience bench - ${s.target}`,
    "",
    "```text",
    renderResilienceSummary(s),
    "```",
    "",
    `- Task completion rate: ${pct(s.completionRate)} (${s.completedRuns}/${s.investigations}; ${s.degradedRuns} more finished degraded with unknowns flagged)`,
    `- Agent failure rate: ${s.agentFailureRate.toFixed(2)} failed slots per investigation (${s.agentFailures} total)`,
    `- Takeover success rate: ${pct(s.takeoverSuccessRate)} (${s.recoveries}/${s.agentFailures}; ${s.exhausted} exhausted)`,
    `- Takeover latency: mean ${ms(s.meanTakeoverMs)}, max ${ms(s.maxTakeoverMs)}; mean detection ${ms(s.meanDetectionMs)}`,
    `- Evidence preservation: ${(100 - s.contextLostPct).toFixed(1)}% (${s.contextPreserved}/${s.contextExpected} tool results carried; ${s.filesRecovered} files and ${s.evidenceRecordsRecovered} evidence records recovered)`,
    `- Critic rejection rate: ${pct(s.criticRejectionRate)} (${s.criticRejections}/${s.criticVerdicts} verdicts)`,
    `- Tool failure recovery: ${pct(s.toolRecoveryRate)} (${s.toolRecovered}/${s.toolFaults} recovered by retry or fallback, ${s.toolDegraded} degraded)`,
    `- Total latency: ${Math.round(s.totalLatencyMs)}ms (mean ${Math.round(s.meanLatencyMs)}ms per investigation)`,
    `- Total cost: $${s.totalCostUsd.toFixed(4)} (mean $${s.meanCostUsd.toFixed(4)} per investigation)`,
    `- Human approval rate: ${pct(s.approvalRate)} (${s.approvalsGranted}/${s.approvalsRequested} requests)`,
    "",
    ...markdownTable(
      ["Mode", "Runs", "Completed", "Agent failures", "Recoveries"],
      s.byMode.map((m) => [
        m.mode,
        String(m.runs),
        `${m.completed}/${m.runs}`,
        String(m.agentFailures),
        String(m.recoveries),
      ]),
    ),
  ].join("\n");
}
