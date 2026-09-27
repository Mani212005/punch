import path from "node:path";
import {
  createDefaultAdapterRegistry,
  createJev,
  createTypeSafeTransport,
  fixtureRunOptions,
  isRunFixture,
  loadRunFixture,
  runLoop,
  type RunLoopOptions,
  type RunResult,
} from "@punch/core";
import type { TraceEvent } from "@punch/shared";
import { getConfigPath, loadConfig } from "./config/index.js";

import { createCliApprovalGate } from "./cli-approval.js";

export interface RunCommandOptions {
  config?: string;
  chaos?: string[];
  unattended?: boolean;
  budgetUsd?: number;
  runsDir?: string;
  signal?: AbortSignal;
  /** One line per notable event; defaults to stdout. */
  log?: (line: string) => void;
}

/** One human line per notable trace event, or null for the chatty ones. */
export function describeEvent(e: TraceEvent): string | null {
  switch (e.kind) {
    case "run.started":
      return `run ${e.runId} started (${e.mode} mode${e.chaos.length ? `, chaos: ${e.chaos.join(", ")}` : ""})`;
    case "slot.assigned":
      return `slot ${e.role} -> ${e.agentId} (${e.provenance}), standby: ${e.standby.map((s) => s.agentId).join(", ") || "none"}`;
    case "plan.created":
      return `plan: ${e.subtasks.map((s) => s.id).join(", ")}`;
    case "agent.started":
      return `  ${e.role} ${e.agentId} started${e.subtaskId ? ` ${e.subtaskId}` : ""}`;
    case "critic.verdict":
      return `  critic ${e.verdict} ${e.subtaskId}`;
    case "blackboard.written":
      return `  blackboard ${e.key} (${e.entry.status})`;
    case "slot.stalled":
      return `  slot ${e.role} stalled: no events for ${e.silentMs}ms${e.nudged ? " (nudged)" : ""}`;
    case "slot.failed":
      return `  slot ${e.role} failed (${e.reason.kind}): ${e.reason.detail}`;
    case "slot.rejected":
      return `  slot ${e.role} rejected ${e.rejections} times`;
    case "slot.replacing":
      return `  slot ${e.role}: ${e.failedAgentId} -> ${e.replacementAgentId} (${e.selection.provenance}), ${e.handoff.cachedResultCount} cached results handed over`;
    case "slot.replaced":
      return `  slot ${e.role} replaced in ${e.takeoverMs}ms`;
    case "slot.exhausted":
      return `  slot ${e.role} exhausted: ${e.reason}`;
    case "replan.triggered":
      return `replan triggered by ${e.subtaskId}: ${e.reason}`;
    case "approval.requested":
      return `approval requested for ${e.tool}`;
    case "approval.granted":
      return `approval granted (${e.approvalId})`;
    case "approval.denied":
      return `approval denied${e.reason ? `: ${e.reason}` : ""}`;
    case "budget.checked":
      return e.exceeded ? `budget exceeded: ${e.exceeded}` : null;
    case "run.finished":
      return `run finished: ${e.status}${e.summary ? ` - ${e.summary}` : ""}`;
    default:
      return null;
  }
}

async function resolveRunTarget(target: string): Promise<string> {
  if (target.includes("://") || path.isAbsolute(target)) return target;
  if (await isRunFixture(target)) return target;

  const invocationDir = process.env.PWD;
  if (invocationDir) {
    const fromInvocation = path.resolve(invocationDir, target);
    if (await isRunFixture(fromInvocation)) return fromInvocation;
  }
  return target;
}

/**
 * `punch run <repo-url|fixture>`. A directory containing `run.json` replays recorded model and
 * tool responses offline; anything else is a repository URL run against the configured agents.
 */
export async function runCommand(
  target: string,
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const runId = `run-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const overrides: Partial<RunLoopOptions> = {
    runId,
    chaos: options.chaos ?? [],
    approval: {
      unattended: options.unattended ?? false,
      gate: !(options.unattended ?? false)
        ? createCliApprovalGate(options.runsDir ?? "runs", runId)
        : undefined,
    },
    onEvent: (event) => {
      const line = describeEvent(event);
      if (line) log(line);
    },
    ...(options.runsDir ? { runsDir: options.runsDir } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let loopOptions: RunLoopOptions;
  const resolvedTarget = await resolveRunTarget(target);
  if (await isRunFixture(resolvedTarget)) {
    const fixture = await loadRunFixture(resolvedTarget);
    if (options.config) fixture.config = await loadConfig(getConfigPath(options.config));
    loopOptions = fixtureRunOptions(fixture, overrides);
  } else {
    const config = await loadConfig(getConfigPath(options.config));
    loopOptions = {
      task: { repoUrl: target },
      config,
      jev: createJev(createTypeSafeTransport()),
      adapters: createDefaultAdapterRegistry(),
      ...overrides,
    };
  }
  if (options.budgetUsd !== undefined) {
    loopOptions = { ...loopOptions, task: { ...loopOptions.task, budgetUsd: options.budgetUsd } };
  }
  const result = await runLoop(loopOptions);
  log(`trace: ${result.tracePath}`);
  for (const err of result.traceErrors) console.error(`trace write error: ${err}`);
  return result;
}
