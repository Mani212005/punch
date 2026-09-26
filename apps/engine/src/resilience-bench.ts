import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertEvidencePreserved,
  AdapterRegistry,
  CallbackApprovalGate,
  collectResilienceMetrics,
  fixtureRunOptions,
  loadRunFixture,
  runLoop,
  summarizeResilience,
  type ResilienceRunMetrics,
  type ResilienceSummary,
  type FixtureScript,
  type RunFixture,
  type RunHandle,
  type RunLoopOptions,
} from "@punch/core";
import type { AgentAdapter } from "@punch/shared";

/** The eight failure modes of addendum section 6, each as an injection into one investigation. */
export interface FailureMode {
  id: string;
  label: string;
  /** Chaos profiles (plan.md 2.6) applied to the run. */
  chaos: string[];
  /** Modes that need more than a chaos profile edit the fixture or drive the run handle. */
  operatorKill?: { role: "reachability" };
  edit?: (fixture: RunFixture) => void;
}

export const FAILURE_MODES: FailureMode[] = [
  { id: "crash", label: "agent crash", chaos: ["kill-after:reachability:1"] },
  { id: "timeout", label: "timeout", chaos: ["timeout:impact"] },
  { id: "malformed", label: "malformed output", chaos: ["garbage:investigator"] },
  { id: "hallucinated", label: "hallucinated claim", chaos: ["hallucinate:researcher"] },
  { id: "tool-failure", label: "tool failure", chaos: ["tool:get_release_notes:500"] },
  { id: "rate-limit", label: "rate limit", chaos: ["rate-limit:anthropic"] },
  {
    id: "critic-rejection",
    label: "critic rejection",
    chaos: [],
    edit: (fixture) => {
      const critic = (fixture.agents.critic ??= {});
      critic.reject = {
        ...critic.reject,
        "s-inv": [
          { claim: "inventory", problem: "not supported by the manifest", severity: "blocker" },
        ],
      };
      // Only the first inventory agent's drafts are rejected, so its replacement is accepted.
      critic.rejectProducers = ["sonnet"];
    },
  },
  {
    id: "operator-kill",
    label: "operator kill",
    chaos: [],
    operatorKill: { role: "reachability" },
  },
];

export interface ResilienceBenchOptions {
  /** Investigations to run; modes are used round-robin. Default: two per selected mode. */
  runs?: number;
  /** Mode ids to inject, default all eight. */
  modes?: string[];
  runsDir?: string;
  /** Approve the executor's issue request for run n (0-based); default approves every one. */
  approve?: (runIndex: number) => boolean;
  log?: (line: string) => void;
}

/**
 * Adds what a resilience run needs on top of an investigation fixture, without a second copy of
 * it: a backup agent on another provider (so a provider-level failure has somewhere to go), and an
 * approval-gated issue for the executor to file so the human approval rate is measured.
 */
export function prepareResilienceFixture(fixture: RunFixture): RunFixture {
  const providers = fixture.config.providers;
  if (providers.length < 2) {
    const first = fixture.config.agents[0]!;
    fixture.config.providers = [
      ...providers,
      { id: "google", kind: "gemini", apiKeyEnv: "GEMINI_API_KEY" },
    ];
    fixture.config.agents = [
      ...fixture.config.agents,
      {
        id: "gemini",
        displayName: "Gemini",
        providerId: "google",
        model: "gemini-fixture",
        costTier: "low",
        roles: first.roles,
        strengths: "Fast, cheap backup on a different provider",
      },
    ];
    const answers = (
      fixture.jev.routeTask as {
        answers: Record<string, { probabilities?: Record<string, number> }>;
      }
    ).answers;
    for (const [key, answer] of Object.entries(answers)) {
      if (key.startsWith("role_") && answer.probabilities) answer.probabilities["gemini"] = 0.05;
    }
  }
  fixture.http.unshift({
    method: "POST",
    match: "/issues",
    status: 201,
    body: {
      id: 1,
      number: 1,
      title: "Punch investigation",
      html_url: "https://github.com/Mani212005/punch/issues/1",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
    },
  });
  // The report subtask is named s-report, or s-report2 after a targeted replan; cover both.
  const scripts = fixture.agents.executor;
  if (scripts["s-report2"] && !scripts["s-report"])
    scripts["s-report"] = JSON.parse(
      JSON.stringify(scripts["s-report2"])
        .replaceAll('"findings_2"', '"findings"')
        .replaceAll('"validation_2"', '"validation_1"'),
    ) as FixtureScript;
  for (const script of Object.values(scripts)) {
    script.calls = [
      ...(script.calls ?? []),
      {
        tool: "github_create_issue",
        input: {
          owner: "Mani212005",
          repo: "punch",
          title: "Security investigation report",
          body: "Investigation summary and findings requiring human review.",
        },
      },
    ];
  }
  return fixture;
}

/** Wraps every adapter so the given role is killed by the operator after its first tool result. */
function killAfterFirstResult(
  fixture: RunFixture,
  role: string,
): Pick<RunLoopOptions, "adapters" | "onReady"> {
  let handle: RunHandle | undefined;
  let done = false;
  const inner = fixtureRunOptions(fixture).adapters;
  const adapters = new AdapterRegistry();
  for (const kind of inner.kinds()) {
    adapters.register(kind, (ctx) => {
      const adapter = inner.create(ctx);
      return {
        capabilities: adapter.capabilities,
        test: () => adapter.test(),
        async *run(input) {
          for await (const event of adapter.run(input)) {
            yield event;
            if (!done && input.role === role && event.type === "tool_result") {
              done = true;
              handle!.kill(role as "reachability", "operator kill (resilience bench)");
            }
          }
        },
      } satisfies AgentAdapter;
    });
  }
  return { adapters, onReady: (h) => (handle = h) };
}

/**
 * `punch bench <fixture> --resilience` (plan.md E7): N investigations, each with one failure mode
 * injected, reporting the addendum section 11 metrics and asserting evidence preservation.
 */
export async function resilienceBench(
  target: string,
  options: ResilienceBenchOptions = {},
): Promise<ResilienceSummary> {
  const ids = options.modes ?? FAILURE_MODES.map((m) => m.id);
  const modes = ids.map((id) => {
    const mode = FAILURE_MODES.find((m) => m.id === id);
    if (!mode) {
      throw new Error(
        `punch bench: unknown failure mode "${id}" (known: ${FAILURE_MODES.map((m) => m.id).join(", ")})`,
      );
    }
    return mode;
  });
  const total = options.runs ?? modes.length * 2;
  if (!Number.isInteger(total) || total < modes.length) {
    throw new Error(
      `punch bench: --runs must be an integer of at least ${modes.length} to cover every selected failure mode, got ${options.runs}`,
    );
  }
  const runsDir = options.runsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "punch-resilience-"));
  const log = options.log ?? (() => {});
  const approve = options.approve ?? (() => true);

  const perRun: ResilienceRunMetrics[] = [];
  for (let i = 0; i < total; i++) {
    const mode = modes[i % modes.length]!;
    const fixture = prepareResilienceFixture(await loadRunFixture(target));
    mode.edit?.(fixture);
    // Short supervisor timing so timeout and stall modes resolve in milliseconds, not minutes.
    fixture.config.policy.stallAfterMs = { api: 60_000, cli: 120_000 };
    const hooks = mode.operatorKill ? killAfterFirstResult(fixture, mode.operatorKill.role) : {};
    const start = Date.now();
    const result = await runLoop(
      fixtureRunOptions(fixture, {
        runsDir,
        chaos: mode.chaos,
        maxConcurrency: 1,
        killChannel: false,
        toolTimeoutMs: 10_000,
        attemptTimeoutMs: 150,
        nudgeGraceMs: 20,
        stallCheckIntervalMs: 10,
        approval: {
          gate: new CallbackApprovalGate(() =>
            approve(i)
              ? { approved: true, decidedBy: "bench-operator" }
              : { approved: false, decidedBy: "bench-operator", reason: "bench policy" },
          ),
        },
        ...hooks,
      }),
    );
    const metrics = collectResilienceMetrics({
      runIndex: i + 1,
      runId: result.runId,
      mode: mode.id,
      events: result.events,
      durationMs: Date.now() - start,
    });
    perRun.push(metrics);
    log(
      `bench run ${i + 1}/${total} [${mode.id}]: ${metrics.status}, ${metrics.agentFailures} agent failures, ${metrics.recoveries} recovered`,
    );
  }
  const summary = summarizeResilience(target, perRun);
  assertEvidencePreserved(summary);
  return summary;
}
