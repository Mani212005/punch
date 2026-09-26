import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceEvent } from "@punch/shared";
import { TraceEvent as TraceEventSchema } from "@punch/shared";
import { afterAll, describe, expect, it } from "vitest";
import { CallbackApprovalGate } from "../approval.js";
import { TOOL_SPECS } from "../tools/registry.js";
import { parseTrace } from "../trace/writer.js";
import { fixtureRunOptions, loadRunFixture, type RunFixture } from "./fixture.js";
import { AdapterRegistry, createDefaultAdapterRegistry } from "./registry.js";
import { runLoop, type RunLoopOptions, type RunResult } from "./loop.js";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../../../fixtures/runs/clean");
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-runs-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

async function run(
  extra: Partial<RunLoopOptions> = {},
  edit: (fixture: RunFixture) => void = () => {},
): Promise<RunResult> {
  const fixture = await loadRunFixture(FIXTURE);
  edit(fixture);
  return runLoop(fixtureRunOptions(fixture, { runsDir, toolTimeoutMs: 150, ...extra }));
}

const kinds = (r: RunResult) => r.events.map((e) => e.kind);
const of = <K extends TraceEvent["kind"]>(r: RunResult, kind: K) =>
  r.events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);

/** Every run ends in exactly one run.finished, with a valid, contiguous trace on disk. */
function expectWellFormed(r: RunResult): void {
  expect(r.traceErrors).toEqual([]);
  expect(kinds(r).filter((k) => k === "run.finished")).toHaveLength(1);
  expect(kinds(r).at(-1)).toBe("run.finished");
  expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
  const onDisk = parseTrace(fs.readFileSync(r.tracePath, "utf-8"));
  expect(onDisk).toEqual(r.events);
  for (const e of onDisk) expect(TraceEventSchema.safeParse(e).success).toBe(true);
}

describe("fixture run, no chaos", () => {
  it("completes offline with the expected event sequence", async () => {
    const r = await run();
    expectWellFormed(r);
    expect(r.status).toBe("completed");
    expect(r.reportKey).toBe("report");

    const k = kinds(r);
    expect(k[0]).toBe("run.started");
    // route once, then a slot per role
    expect(k.slice(1, 5)).toEqual(Array(4).fill("route.decided"));
    expect(k.slice(5, 9)).toEqual(Array(4).fill("slot.assigned"));
    expect(k.indexOf("plan.created")).toBeGreaterThan(8);
    expect(k.indexOf("agent.started")).toBeLessThan(k.indexOf("plan.created"));

    const assigned = of(r, "slot.assigned");
    expect(assigned.map((e) => e.role)).toEqual(["planner", "researcher", "executor", "critic"]);
    expect(assigned.find((e) => e.role === "critic")!.agentId).not.toBe(
      assigned.find((e) => e.role === "executor")!.agentId,
    );
    expect(assigned.find((e) => e.role === "researcher")!.standby).toHaveLength(1);

    expect(of(r, "plan.created")).toHaveLength(1);
    expect(
      of(r, "blackboard.written")
        .map((e) => e.key)
        .sort(),
    ).toEqual(["inventory", "report", "upgrade_risk", "vulns"]);
    expect(of(r, "critic.verdict").every((e) => e.verdict === "accepted")).toBe(true);
    expect(of(r, "critic.verdict")).toHaveLength(4);
    expect(of(r, "tool.result").every((e) => e.ok)).toBe(true);
    expect(of(r, "budget.checked").length).toBeGreaterThan(0);

    // dependency order: s4 starts only after its inputs were written
    const written = (key: string) =>
      r.events.findIndex((e) => e.kind === "blackboard.written" && e.key === key);
    const s4Start = r.events.findIndex((e) => e.kind === "agent.started" && e.subtaskId === "s4");
    expect(s4Start).toBeGreaterThan(written("vulns"));
    expect(s4Start).toBeGreaterThan(written("upgrade_risk"));

    // independent subtasks ran concurrently: s3 started before s2 finished
    const s3Start = r.events.findIndex((e) => e.kind === "agent.started" && e.subtaskId === "s3");
    expect(s3Start).toBeLessThan(written("vulns"));

    for (const slot of r.slots) expect(["completed", "failed", "rejected"]).toContain(slot.state);
    expect(r.slots.every((s) => s.lastHeartbeatAt > 0)).toBe(true);
  });
});

const USED_TOOLS = new Set([
  "github_get_contents",
  "parse_dependency_inventory",
  "osv_query",
  "osv_query_batch",
  "github_advisory_graphql",
  "query_vulnerabilities",
  "npm_package_metadata",
  "get_package_metadata",
  "github_get_releases",
  "github_compare_commits",
  "get_release_notes",
]);
const MODES = ["500", "hang", "truncate", "empty"] as const;
const READ_TOOLS = Object.values(TOOL_SPECS)
  .filter((s) => !s.irreversible)
  .map((s) => s.name);

describe("tool chaos profiles (plan.md 3.6)", () => {
  it("the matrix covers every tool the fixture uses", () => {
    for (const tool of USED_TOOLS) expect(READ_TOOLS).toContain(tool);
  });

  for (const tool of READ_TOOLS) {
    for (const mode of MODES) {
      it(`${tool}:${mode} completes ${USED_TOOLS.has(tool) ? "degraded" : "untouched"}`, async () => {
        const r = await run({ chaos: [`tool:${tool}:${mode}`] });
        expectWellFormed(r);
        expect(r.reportKey).toBe("report");
        if (USED_TOOLS.has(tool)) {
          expect(r.status).toBe("degraded");
          expect(Object.values(r.blackboard).some((e) => e.status === "degraded")).toBe(true);
          // the report surfaces the gap instead of hiding it
          expect(r.blackboard["report"]!.status).toBe("degraded");
        } else {
          expect(r.status).toBe("completed");
        }
        // a failing tool is traced as a failed result, never a crash
        if (USED_TOOLS.has(tool) && (mode === "500" || mode === "hang")) {
          expect(of(r, "tool.result").some((e) => !e.ok && e.tool === tool)).toBe(true);
        }
      });
    }
  }

  it("a hung tool times out instead of hanging the run", async () => {
    const started = Date.now();
    const r = await run({ chaos: ["tool:github_get_contents:hang"], toolTimeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(of(r, "tool.result").find((e) => !e.ok)!.error).toMatch(/timed out/);
  });

  it("an unmatched URL is a not_found that degrades", async () => {
    const r = await run({}, (f) => {
      f.http = f.http.filter((h) => h.match !== "/contents/package-lock.json");
    });
    expect(r.status).toBe("degraded");
    expect(r.blackboard["inventory"]!.status).toBe("degraded");
  });
});

describe("stopping conditions", () => {
  const withBudgets =
    (budgets: Partial<{ maxSteps: number; maxUsd: number; maxWallClockMs: number }>) =>
    (f: RunFixture) => {
      f.config.budgets = { ...f.config.budgets, ...budgets };
    };

  function expectWrapUp(r: RunResult, cap: string): void {
    expectWellFormed(r);
    expect(r.status).toBe("degraded");
    expect(r.stoppedBy).toBe(cap);
    const wrap = r.events.find((e) => e.kind === "agent.started" && e.subtaskId === "wrap-up");
    expect(wrap).toBeDefined();
    expect(of(r, "budget.checked").some((e) => e.exceeded === cap)).toBe(true);
    expect(r.reportKey).toBe("final_report");
    expect(r.blackboard["final_report"]!.status).toBe("degraded");
    expect(r.summary).toContain(cap);
    // the wrap-up is one executor turn, after the stop
    expect(of(r, "agent.started").filter((e) => e.subtaskId === "wrap-up")).toHaveLength(1);
  }

  it("stops on the step cap and still writes a report on the reserved slice", async () => {
    const r = await run({}, withBudgets({ maxSteps: 9 }));
    expectWrapUp(r, "steps");
    expect(
      r.events.filter((e) => e.kind === "budget.checked").at(-1)!.steps.used,
    ).toBeLessThanOrEqual(9);
  });

  it("stops on the usd cap", async () => {
    const r = await run({}, withBudgets({ maxUsd: 0.005 }));
    expectWrapUp(r, "usd");
  });

  it("stops on the wall-clock cap, aborting hung work", async () => {
    const r = await run(
      { chaos: ["tool:github_get_contents:hang"], toolTimeoutMs: 60_000, wrapUpTimeoutMs: 5000 },
      withBudgets({ maxWallClockMs: 250 }),
    );
    expectWrapUp(r, "wallClock");
  }, 10000);

  it("an operator abort finishes aborted with a wrap-up", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await run({
      signal: controller.signal,
      chaos: ["tool:github_get_contents:hang"],
      toolTimeoutMs: 60_000,
      wrapUpTimeoutMs: 5000,
    });
    expectWellFormed(r);
    expect(r.status).toBe("aborted");
    expect(r.stoppedBy).toBe("operator");
    expect(r.blackboard["final_report"]).toBeDefined();
  });
});

describe("failure, replan and rejection", () => {
  const replacementPlan = (f: RunFixture, retryScript: boolean) => {
    const plan = f.agents.planner.plan as { subtasks: Record<string, unknown>[] };
    const s2 = plan.subtasks.find((s) => s["id"] === "s2")!;
    const s4 = plan.subtasks.find((s) => s["id"] === "s4")!;
    f.agents.planner.replan = {
      subtasks: [
        { ...s2, id: "s2b" },
        { ...s4, dependsOn: (s4["dependsOn"] as string[]).map((d) => (d === "s2" ? "s2b" : d)) },
      ],
    };
    if (retryScript) f.agents.researcher["s2b"] = f.agents.researcher["s2"]!;
  };

  it("a permanent failure with dependents triggers exactly one replan and recovers", async () => {
    const r = await run({}, (f) => {
      replacementPlan(f, true);
      delete f.agents.researcher["s2"];
    });
    expectWellFormed(r);
    expect(of(r, "replan.triggered")).toHaveLength(1);
    expect(of(r, "replan.triggered")[0]!.subtaskId).toBe("s2");
    expect(of(r, "plan.created")).toHaveLength(2);
    expect(of(r, "slot.failed").some((e) => e.subtaskId === "s2")).toBe(true);
    expect(r.status).toBe("completed");
    expect(r.blackboard["vulns"]!.status).toBe("ok");
    expect(r.blackboard["report"]).toBeDefined();
  });

  it("a second failure does not replan again; the subtask degrades and the run goes on", async () => {
    const r = await run({}, (f) => {
      replacementPlan(f, false);
      delete f.agents.researcher["s2"];
    });
    expectWellFormed(r);
    expect(of(r, "replan.triggered")).toHaveLength(1);
    expect(r.status).toBe("degraded");
    expect(r.blackboard["vulns"]!.status).toBe("degraded");
    expect(r.blackboard["report"]!.status).toBe("degraded");
  });

  it("a permanent failure with no dependents does not replan", async () => {
    const r = await run({}, (f) => {
      delete f.agents.executor["s4"];
    });
    expectWellFormed(r);
    expect(of(r, "replan.triggered")).toHaveLength(0);
    expect(r.status).toBe("degraded");
    expect(r.blackboard["report"]!.status).toBe("degraded");
  });

  it("a critic rejection can request a task, which becomes a targeted replan on its own bounded path", async () => {
    const finding = {
      claim: "qs 6.5.2 is affected",
      problem: "needs a second source",
      severity: "blocker",
      requestedTask: {
        title: "Second source",
        description: "Check GHSA directly",
        roleHint: "researcher",
      },
    };
    const r = await run({}, (f) => {
      replacementPlan(f, true);
      f.agents.critic = { reject: { s2: [finding] } };
    });
    expectWellFormed(r);
    expect(of(r, "slot.rejected")).toHaveLength(1);
    expect(of(r, "slot.rejected")[0]!.rejections).toBe(2);
    expect(of(r, "replan.triggered")).toHaveLength(1);
    expect(of(r, "replan.triggered")[0]!.reason).toContain("Second source");
    expect(of(r, "critic.verdict").filter((e) => e.subtaskId === "s2")).toHaveLength(2);
    expect(r.status).toBe("completed");
  });

  it("a rejection without a requested task degrades without a replan", async () => {
    const r = await run({}, (f) => {
      f.agents.critic = {
        reject: { s2: [{ claim: "c", problem: "unsupported", severity: "blocker" }] },
      };
    });
    expectWellFormed(r);
    expect(of(r, "replan.triggered")).toHaveLength(1); // s2 has dependents: the failure replan
    expect(r.status).toBe("degraded");
  });
});

describe("approval gate", () => {
  const filesIssue = (f: RunFixture) => {
    f.agents.executor["s4"]!.calls!.push({
      tool: "github_create_issue",
      input: { owner: "Mani212005", repo: "punch", title: "Remediation", body: "qs" },
    });
  };

  it("--unattended auto-denies an irreversible tool", async () => {
    const r = await run({ approval: { unattended: true } }, filesIssue);
    expectWellFormed(r);
    expect(of(r, "approval.requested")).toHaveLength(1);
    expect(of(r, "approval.denied")).toHaveLength(1);
    expect(of(r, "approval.granted")).toHaveLength(0);
    expect(r.status).toBe("degraded");
  });

  it("without an attached approver nothing is approved", async () => {
    const r = await run({}, filesIssue);
    expect(of(r, "approval.denied")).toHaveLength(1);
  });

  it("the approval hook decides", async () => {
    const seen: string[] = [];
    const r = await run(
      {
        approval: {
          gate: new CallbackApprovalGate((req) => {
            seen.push(req.tool);
            return { approved: true, decidedBy: "test" };
          }),
        },
      },
      filesIssue,
    );
    expectWellFormed(r);
    expect(seen).toEqual(["github_create_issue"]);
    expect(of(r, "approval.granted")[0]!.decidedBy).toBe("test");
  });
});

describe("adapter selection", () => {
  it("a provider kind with no registered adapter fails the run cleanly", async () => {
    const r = await run({ adapters: new AdapterRegistry() });
    expectWellFormed(r);
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("no adapter registered");
    expect(of(r, "slot.failed")[0]!.role).toBe("planner");
  });

  it("the default registry serves anthropic", () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.kinds()).toEqual(expect.arrayContaining(["anthropic", "gemini"]));
  });
});

describe("committed traces", () => {
  it("traces/clean.jsonl is a valid, complete offline run", () => {
    const file = path.resolve(FIXTURE, "../../../traces/clean.jsonl");
    const events = parseTrace(fs.readFileSync(file, "utf-8"));
    expect(events[0]!.kind).toBe("run.started");
    const last = events.at(-1)!;
    expect(last.kind === "run.finished" && last.status).toBe("completed");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
  });
});
