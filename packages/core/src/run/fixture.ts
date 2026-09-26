import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  Config,
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type Provider,
} from "@punch/shared";
import { GitHubAdvisoryClient } from "../tools/gh-advisory.js";
import { GitHubClient } from "../tools/github.js";
import { NpmClient } from "../tools/npm.js";
import { OSVClient } from "../tools/osv.js";
import { classifyErrorByCode } from "../router/classify-error.js";
import { createJev, createRecordedTransport, type Jev, type JevTransport } from "../router/jev.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import type { AdapterFactoryContext } from "./registry.js";
import { AdapterRegistry } from "./registry.js";
import type { RunLoopOptions } from "./loop.js";

/**
 * Fixture runs replay recorded responses with no network: HTTP bodies for the tool clients,
 * Jev answers, and a script per agent role. The tools themselves are the real A3 tools, so
 * chaos, caching, retries and fallbacks behave exactly as in a live run.
 */

export interface FixtureCall {
  tool: string;
  /** Tool input; `{ "$from": n, "path": "a.b" }` reads a field of call n's output (1-based). */
  input: Record<string, unknown>;
  /** Dotted path that must be non-empty in the output, else the agent treats the call as failed. */
  require?: string;
}

export interface FixtureResult {
  value: unknown;
  /** `toolCallId: "$n"` refers to the n-th call of the script. */
  evidence: Record<string, unknown>[];
  degradedReason?: string;
}

export interface FixtureScript {
  calls?: FixtureCall[];
  result: FixtureResult;
  /** Used instead of `result` when any call failed or came back empty. */
  degraded: FixtureResult;
}

export interface FixtureHttpRule {
  method?: string;
  /** Substring of the request URL. First match wins; no match is a 404. */
  match: string;
  /** Response body file, relative to the fixture directory. */
  file?: string;
  status?: number;
  body?: unknown;
}

export interface RunFixture {
  dir: string;
  description?: string;
  task: { repoUrl: string; brief?: string };
  config: Config;
  jev: {
    routeTask: unknown;
    routeSubtask: Record<string, unknown> & { default: unknown };
    claimSupport?: number;
  };
  http: FixtureHttpRule[];
  agents: {
    /** `replan` answers every planner call after the first. */
    planner: { plan: unknown; replan?: unknown };
    /** Subtasks whose drafts the critic rejects, with the findings it returns. */
    critic?: {
      reject?: Record<string, unknown[]>;
      /** Reject only drafts produced by these agents, so a replacement's draft is accepted. */
      rejectProducers?: string[];
    };
    researcher: Record<string, FixtureScript>;
    executor: Record<string, FixtureScript>;
  };
}

const RUN_FILE = "run.json";

/** True when `target` is a fixture directory rather than a repository URL. */
export async function isRunFixture(target: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(target, RUN_FILE))).isFile();
  } catch {
    return false;
  }
}

export async function loadRunFixture(dir: string): Promise<RunFixture> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, RUN_FILE), "utf-8")) as RunFixture;
  return { ...raw, dir: path.resolve(dir), config: Config.parse(raw.config) };
}

// -- HTTP ----------------------------------------------------------------

export function createFixtureFetch(fixture: RunFixture): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const rule = fixture.http.find(
      (r) => url.includes(r.match) && (!r.method || r.method.toUpperCase() === method),
    );
    if (!rule) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = rule.file
      ? await fs.readFile(path.resolve(fixture.dir, rule.file), "utf-8")
      : JSON.stringify(rule.body ?? {});
    return new Response(body, {
      status: rule.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

export function createFixtureClients(
  fixture: RunFixture,
): NonNullable<ToolExecutionContext["clients"]> {
  const fetch = createFixtureFetch(fixture);
  return {
    github: new GitHubClient({ fetch }),
    osv: new OSVClient({ fetch }),
    npm: new NpmClient({ fetch }),
    advisory: new GitHubAdvisoryClient({ fetch, token: "fixture" }),
  };
}

// -- Jev -----------------------------------------------------------------

function createFixtureJevTransport(fixture: RunFixture): JevTransport {
  const routeTask = createRecordedTransport([fixture.jev.routeTask as never]);
  const support = fixture.jev.claimSupport ?? 0.95;
  const usage = { input_tokens: 0, output_tokens: 0 };
  return {
    async evaluate(request, options) {
      const ids = Object.keys(request.questions);
      if (ids.includes("difficulty")) return routeTask.evaluate(request, options);
      if (ids.includes("assignee")) {
        const title = (request.state as { subtask?: { title?: string } }).subtask?.title ?? "";
        const recorded = fixture.jev.routeSubtask[title] ?? fixture.jev.routeSubtask.default;
        return createRecordedTransport([recorded as never]).evaluate(request, options);
      }
      if (ids.includes("error_class")) {
        const state = request.state as { error?: string; httpStatus?: number | null };
        const errorClass = classifyErrorByCode({
          text: state.error ?? "",
          ...(state.httpStatus ? { status: state.httpStatus } : {}),
        });
        return {
          model: "jev-fixture",
          answers: {
            error_class: {
              type: "choice",
              choice: errorClass,
              confidence: 0.9,
              probabilities: { [errorClass]: 0.9 },
            },
          },
          usage,
        };
      }
      if (ids.every((id) => id.startsWith("claim_"))) {
        // A claim whose cited tool call does not exist in the trace is not supported.
        const score = (id: string): number =>
          JSON.stringify(request.questions[id] ?? "").includes("exists in the trace")
            ? 0.05
            : support;
        return {
          model: "jev-fixture",
          answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: score(id) }])),
          usage,
        };
      }
      throw new Error(`fixture has no recorded Jev answer for [${ids.join(", ")}]`);
    },
  };
}

export function createFixtureJev(fixture: RunFixture): Jev {
  return createJev(createFixtureJevTransport(fixture));
}

// -- agents --------------------------------------------------------------

const CAPABILITIES: AdapterCapabilities = {
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  effort: true,
};

function readPath(value: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], value);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** A model stand-in that replays the recorded script and degrades when its tools fail. */
class FixtureAdapter implements AgentAdapter {
  readonly capabilities = CAPABILITIES;
  constructor(
    private readonly fixture: RunFixture,
    private readonly ctx: AdapterFactoryContext,
    private readonly planCalls: { count: number },
  ) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "fixture" };
  }

  async *run(input: Parameters<AgentAdapter["run"]>[0]): AsyncGenerator<AgentEvent> {
    const { role } = input;
    if (this.ctx.chaos.providerDown.includes(this.ctx.provider.id)) {
      yield {
        type: "done",
        status: "error",
        error: "503 service unavailable (chaos provider-down)",
      };
      return;
    }
    const usage = { inputTokens: 900, outputTokens: 150 };
    if (role === "planner") {
      this.planCalls.count += 1;
      yield { type: "text", text: "Decomposing the brief into a subtask DAG." };
      yield { type: "usage", usage };
      const { plan, replan } = this.fixture.agents.planner;
      yield {
        type: "result",
        output: this.planCalls.count > 1 && replan !== undefined ? replan : plan,
      };
      yield { type: "done", status: "ok" };
      return;
    }
    if (role === "critic") {
      const reviewed = /subtask (\S+?):/.exec(input.task)?.[1] ?? "";
      const producer = /Produced by the \S+ \((\S+?)\)/.exec(input.task)?.[1];
      const only = this.fixture.agents.critic?.rejectProducers;
      const findings =
        !only || (producer !== undefined && only.includes(producer))
          ? this.fixture.agents.critic?.reject?.[reviewed]
          : undefined;
      yield {
        type: "text",
        text: findings
          ? "Rejecting: the draft is not supported."
          : "Checked each claim against its cited evidence; all supported.",
      };
      yield { type: "usage", usage };
      yield {
        type: "result",
        output: findings
          ? { verdict: "rejected", findings }
          : { verdict: "accepted", findings: [] },
      };
      yield { type: "done", status: "ok" };
      return;
    }
    const subtaskId = /Subtask (\S+?):/.exec(input.task)?.[1] ?? "";
    const handoff = input.inputs["handoff"] as
      | {
          predecessor: { agentId: string };
          cachedToolResults: unknown[];
          filesInspected: unknown[];
          evidenceRecords: unknown[];
        }
      | undefined;
    const scripts =
      role === "researcher" ? this.fixture.agents.researcher : this.fixture.agents.executor;
    const script = scripts[subtaskId] ?? scripts["*"];
    if (!script) {
      yield {
        type: "done",
        status: "error",
        error: `fixture has no ${role} script for ${subtaskId}`,
      };
      return;
    }

    const outputs: unknown[] = [];
    const okCalls: boolean[] = [];
    const resolveInput = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveInput);
      if (value && typeof value === "object") {
        const ref = value as { $from?: number; path?: string };
        if (typeof ref.$from === "number") {
          if (!okCalls[ref.$from - 1]) throw new Error(`call ${ref.$from} did not succeed`);
          return readPath(outputs[ref.$from - 1], ref.path ?? "");
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveInput(v)]));
      }
      return value;
    };

    yield {
      type: "text",
      text: handoff
        ? `Taking over ${subtaskId} from ${handoff.predecessor.agentId}: ${handoff.cachedToolResults.length} cached tool results, ${handoff.filesInspected.length} files inspected, ${handoff.evidenceRecords.length} evidence records. Continuing, not restarting.`
        : `Working on ${subtaskId}.`,
    };
    const calls = script.calls ?? [];
    for (const [i, call] of calls.entries()) {
      if (input.signal.aborted) return;
      const callId = `${subtaskId}-c${i + 1}`;
      let resolved: Record<string, unknown>;
      try {
        resolved = resolveInput(call.input) as Record<string, unknown>;
      } catch (err) {
        okCalls[i] = false;
        outputs[i] = undefined;
        yield { type: "text", text: `Skipping ${call.tool}: ${(err as Error).message}` };
        continue;
      }
      yield { type: "tool_call", callId, tool: call.tool, input: resolved };
      let ok = true;
      let output: unknown;
      try {
        output = await this.ctx.executeTool({
          name: call.tool,
          input: resolved,
          callId,
          signal: input.signal,
        });
        if (call.require && isEmpty(readPath(output, call.require))) ok = false;
        if (
          call.tool === "read_blackboard" &&
          (output as { status?: string }).status === "degraded"
        )
          ok = false;
      } catch (err) {
        ok = false;
        output = err instanceof Error ? err.message : String(err);
      }
      okCalls[i] = ok;
      outputs[i] = output;
      yield { type: "tool_result", callId, tool: call.tool, ok, output };
      // A real agent spends a model turn between tool calls; a macrotask keeps the replay
      // interleavable, so operator kills and stall checks can land mid-subtask.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const failed = okCalls.some((ok) => !ok);
    const chosen = failed ? script.degraded : script.result;
    const withCallIds = JSON.parse(
      JSON.stringify(chosen).replace(/"\$(\d+)"/g, (_m, n: string) => `"${subtaskId}-c${n}"`),
    ) as FixtureResult;
    yield {
      type: "text",
      text: failed
        ? "Some tool calls failed or came back empty; reporting those parts as unknown."
        : "All lookups succeeded.",
    };
    yield { type: "usage", usage };
    yield { type: "result", output: withCallIds };
    yield { type: "done", status: "ok" };
  }
}

const ALL_KINDS: Provider["kind"][] = [
  "anthropic",
  "gemini",
  "xai",
  "openai-compatible",
  "claude-code",
  "opencode",
  "antigravity",
  "grok-cli",
];

export function createFixtureAdapterRegistry(fixture: RunFixture): AdapterRegistry {
  const planCalls = { count: 0 };
  const registry = new AdapterRegistry();
  for (const kind of ALL_KINDS) {
    registry.register(kind, (ctx) => new FixtureAdapter(fixture, ctx, planCalls));
  }
  return registry;
}

/** Everything `runLoop` needs to replay the fixture offline. */
export function fixtureRunOptions(
  fixture: RunFixture,
  overrides: Partial<RunLoopOptions> = {},
): RunLoopOptions {
  return {
    task: fixture.task,
    config: fixture.config,
    jev: createFixtureJev(fixture),
    adapters: createFixtureAdapterRegistry(fixture),
    clients: createFixtureClients(fixture),
    ...overrides,
  };
}
