import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createDefaultAdapterRegistry,
  createJev,
  createTypeSafeTransport,
  fixtureRunOptions,
  isRunFixture,
  loadRunFixture,
  runLoop,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type RunHandle,
  type RunLoopOptions,
  type RunResult,
} from "@punch/core";
import type { RunSummary, SlotRole, TraceEvent } from "@punch/shared";
import { getConfigPath, loadConfig } from "../config/loader.js";
import type { CreateRunBody } from "./schemas.js";

export type TerminalRunStatus = "completed" | "degraded" | "aborted" | "failed";
export type LiveRunStatus = "running" | "awaiting_approval";
export type RunRecordStatus = LiveRunStatus | TerminalRunStatus;

/** An approval the run is blocked on, shown in GET /runs/:id and the console modal. */
export interface PendingApproval {
  approvalId: string;
  tool: string;
  payload: unknown;
  subtaskId?: string;
  agentId?: string;
  requestedAt: number;
}

/**
 * The A10 gate over HTTP: `requestApproval` blocks until the console or
 * `POST /runs/:id/approvals/:approvalId` answers. Stopping or finishing the
 * run denies everything still pending so no tool waits forever.
 */
export class HttpApprovalGate implements ApprovalGate {
  private readonly pending = new Map<
    string,
    { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }
  >();

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.approvalId, { request, resolve });
    });
  }

  list(now: number): PendingApproval[] {
    return [...this.pending.values()].map(({ request }) => ({
      approvalId: request.approvalId,
      tool: request.tool,
      payload: request.payload,
      ...(request.subtaskId ? { subtaskId: request.subtaskId } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      requestedAt: now,
    }));
  }

  get size(): number {
    return this.pending.size;
  }

  answer(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    entry.resolve(decision);
    return true;
  }

  denyAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.resolve({ approved: false, decidedBy: "engine", reason });
    }
  }
}

export interface RunDetail {
  summary: RunSummary;
  chaos: string[];
  pendingApprovals: PendingApproval[];
  assignments: unknown[];
}

export interface RunRegistryOptions {
  runsDir: string;
  configPath?: string;
  now?: () => number;
  /** Test hook: adjust the loop options (e.g. slow the adapters) before start. */
  transformRunOptions?: (options: RunLoopOptions, body: CreateRunBody) => RunLoopOptions;
}

interface RunRecord {
  id: string;
  repoUrl: string;
  startedAt: number;
  finishedAt?: number;
  chaos: string[];
  assignments: unknown[];
  events: TraceEvent[];
  settled: boolean;
  result: RunResult | null;
  handle: RunHandle | null;
  abort: AbortController;
  gate: HttpApprovalGate;
  listeners: Set<() => void>;
}

function newRunId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Owns every live run: starts `runLoop` with the HTTP approval gate, keeps
 * the trace events the A1 writer emits (via the loop's subscriber API) for
 * SSE replay, and exposes kill/stop/answer for the control routes.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  /** Chaos stored for a run id that does not exist yet; merged at creation. */
  private readonly pendingChaos = new Map<string, string[]>();
  private readonly runsDir: string;
  private readonly configPath?: string;
  private readonly now: () => number;
  private readonly transformRunOptions?: (
    options: RunLoopOptions,
    body: CreateRunBody,
  ) => RunLoopOptions;

  constructor(options: RunRegistryOptions) {
    this.runsDir = options.runsDir;
    this.configPath = options.configPath;
    this.now = options.now ?? (() => Date.now());
    this.transformRunOptions = options.transformRunOptions;
  }

  /** Profiles staged by POST /runs/:id/chaos for a run that has not started. */
  stageChaos(runId: string, profiles: string[]): void {
    const existing = this.pendingChaos.get(runId) ?? [];
    this.pendingChaos.set(runId, [...existing, ...profiles]);
  }

  async start(body: CreateRunBody): Promise<{ id: string }> {
    const at = this.now();
    const id = body.runId ?? newRunId(at);
    if (this.runs.has(id)) throw new ConflictError(`run ${id} already exists`);
    const staged = this.pendingChaos.get(id) ?? [];
    this.pendingChaos.delete(id);
    const chaos = [...staged, ...body.chaos];

    const gate = new HttpApprovalGate();
    const abort = new AbortController();
    const record: RunRecord = {
      id,
      repoUrl: body.repoUrl ?? body.fixture ?? "unknown",
      startedAt: at,
      chaos,
      assignments: [],
      events: [],
      settled: false,
      result: null,
      handle: null,
      abort,
      gate,
      listeners: new Set(),
    };
    const notify = (): void => {
      for (const listener of [...record.listeners]) listener();
    };

    let options: RunLoopOptions;
    if (body.fixture !== undefined) {
      if (!(await isRunFixture(body.fixture))) {
        throw new BadRequestError(`not a fixture directory: ${body.fixture}`);
      }
      const fixture = await loadRunFixture(body.fixture);
      options = fixtureRunOptions(fixture, {
        runId: id,
        chaos,
        approval: { gate },
        runsDir: this.runsDir,
        signal: abort.signal,
        onEvent: (event) => {
          record.events.push(event);
          notify();
        },
        onReady: (handle) => {
          record.handle = handle;
        },
      });
      if (body.budgetUsd !== undefined) {
        options = { ...options, task: { ...options.task, budgetUsd: body.budgetUsd } };
      }
      if (body.brief !== undefined) {
        options = { ...options, task: { ...options.task, brief: body.brief } };
      }
    } else if (body.repoUrl !== undefined) {
      const config = await loadConfig(getConfigPath(this.configPath));
      options = {
        task: {
          repoUrl: body.repoUrl,
          ...(body.brief ? { brief: body.brief } : {}),
          ...(body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : {}),
        },
        config,
        jev: createJev(createTypeSafeTransport()),
        adapters: createDefaultAdapterRegistry(),
        runId: id,
        chaos,
        approval: { gate },
        runsDir: this.runsDir,
        signal: abort.signal,
        onEvent: (event) => {
          record.events.push(event);
          notify();
        },
        onReady: (handle) => {
          record.handle = handle;
        },
      };
    } else {
      throw new BadRequestError("one of repoUrl or fixture is required");
    }
    if (body.mode !== undefined) options = { ...options, mode: body.mode };
    if (this.transformRunOptions) options = this.transformRunOptions(options, body);

    this.runs.set(id, record);
    const promise = runLoop(options);
    promise.then(
      (result) => {
        record.settled = true;
        record.result = result;
        record.finishedAt = this.now();
        gate.denyAll("run finished");
        notify();
      },
      () => {
        // runLoop never rejects for run-time failures, but a setup throw
        // outside the loop (routing is inside) still must settle the record.
        record.settled = true;
        record.finishedAt = this.now();
        gate.denyAll("run finished");
        notify();
      },
    );
    return { id };
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map((record) => this.summarize(record));
  }

  detail(id: string): RunDetail | null {
    const record = this.runs.get(id);
    if (!record) return null;
    return {
      summary: this.summarize(record),
      chaos: record.chaos,
      pendingApprovals: record.gate.list(this.now()),
      assignments: record.assignments,
    };
  }

  private summarize(record: RunRecord): RunSummary {
    let status: RunRecordStatus = "running";
    if (record.settled) {
      status = (record.result?.status ?? "failed") as TerminalRunStatus;
    } else if (record.gate.size > 0) {
      status = "awaiting_approval";
    }
    return {
      id: record.id,
      repoUrl: record.repoUrl,
      status,
      startedAt: record.startedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    };
  }

  events(id: string): TraceEvent[] | null {
    return this.runs.get(id)?.events ?? null;
  }

  isSettled(id: string): boolean {
    return this.runs.get(id)?.settled ?? false;
  }

  /** Live subscription: returns false when the run is unknown. */
  subscribe(id: string, listener: () => void): boolean {
    const record = this.runs.get(id);
    if (!record) return false;
    record.listeners.add(listener);
    return true;
  }

  unsubscribe(id: string, listener: () => void): void {
    this.runs.get(id)?.listeners.delete(listener);
  }

  kill(id: string, role: SlotRole): { killed: boolean } | null {
    const record = this.runs.get(id);
    if (!record || record.settled) return record ? { killed: false } : null;
    return { killed: record.handle?.kill(role) ?? false };
  }

  stop(id: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.settled) return false;
    record.gate.denyAll("run stopped by the operator");
    record.abort.abort();
    return true;
  }

  setAssignments(id: string, assignments: unknown): boolean {
    const record = this.runs.get(id);
    if (!record) return false;
    record.assignments.push(assignments);
    return true;
  }

  answerApproval(
    id: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): "answered" | "unknown-run" | "unknown-approval" {
    const record = this.runs.get(id);
    if (!record) return "unknown-run";
    return record.gate.answer(approvalId, decision) ? "answered" : "unknown-approval";
  }

  setChaos(id: string, profiles: string[]): "staged" | "conflict" {
    const record = this.runs.get(id);
    if (!record) {
      this.stageChaos(id, profiles);
      return "staged";
    }
    return "conflict";
  }

  /**
   * The raw trace as JSONL. Live runs serve the in-memory events (the file
   * lags them); unknown ids fall back to the trace file on disk, if any.
   */
  async traceJsonl(id: string): Promise<string | null> {
    const record = this.runs.get(id);
    if (record)
      return (
        record.events.map((event) => JSON.stringify(event)).join("\n") +
        (record.events.length > 0 ? "\n" : "")
      );
    try {
      return await fs.readFile(path.join(this.runsDir, id, "trace.jsonl"), "utf-8");
    } catch {
      return null;
    }
  }
}

export class BadRequestError extends Error {}
export class ConflictError extends Error {}
