import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InvestigationFinding,
  TraceEvent as TraceEventSchema,
  type TraceEvent,
} from "@punch/shared";
import { afterAll, describe, expect, it } from "vitest";
import { validatePlan } from "../planner.js";
import { ImpactResultSchema } from "../roles/impact.js";
import { InvestigatorResultSchema } from "../roles/investigator.js";
import { InventoryResultSchema } from "../roles/inventory.js";
import { ReachabilityResultSchema } from "../roles/reachability.js";
import { VulnerabilityResearchSchema } from "../roles/researcher.js";
import { ValidationStepResultSchema } from "../roles/validator.js";
import { parseTrace } from "../trace/writer.js";
import { fixtureRunOptions, loadRunFixture } from "./fixture.js";
import type { RunResult } from "./loop.js";
import { runLoop } from "./loop.js";

const FIXTURE = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../fixtures/runs/investigation",
);
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-investigation-"));
afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

async function run(): Promise<RunResult> {
  const fixture = await loadRunFixture(FIXTURE);
  return runLoop(fixtureRunOptions(fixture, { runsDir, toolTimeoutMs: 10000 }));
}

const kinds = (r: RunResult) => r.events.map((e) => e.kind);
const of = <K extends TraceEvent["kind"]>(r: RunResult, kind: K) =>
  r.events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);

function expectWellFormed(r: RunResult): void {
  expect(r.traceErrors).toEqual([]);
  expect(kinds(r).filter((k) => k === "run.finished")).toHaveLength(1);
  expect(kinds(r).at(-1)).toBe("run.finished");
  expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i));
  const onDisk = parseTrace(fs.readFileSync(r.tracePath, "utf-8"));
  expect(onDisk).toEqual(r.events);
  for (const e of onDisk) expect(TraceEventSchema.safeParse(e).success).toBe(true);
}

describe("E2 investigation run (offline fixture)", () => {
  it("runs the full template: inventory/research, reachability/impact, investigator, critic, sandbox, report", async () => {
    const r = await run();
    expectWellFormed(r);
    expect(r.status).toBe("completed");

    // All eight slots were routed and assigned.
    const assigned = of(r, "slot.assigned");
    expect(assigned.map((e) => e.role).sort()).toEqual(
      [
        "critic",
        "executor",
        "impact",
        "inventory",
        "investigator",
        "planner",
        "reachability",
        "researcher",
      ].sort(),
    );

    // The planner emitted a valid investigation DAG: inventory + research in parallel,
    // reachability + impact in parallel per finding, investigator, code validation, report.
    const created = of(r, "plan.created");
    expect(created).toHaveLength(2); // initial plan + targeted replan
    const plan = created[0]!.subtasks;
    expect(validatePlan({ subtasks: plan })).toEqual([]);
    const byId = new Map(plan.map((s) => [s.id, s]));
    expect(byId.get("s-inv")!.roleHint).toBe("inventory");
    expect(byId.get("s-vuln")!.roleHint).toBe("researcher");
    expect(byId.get("s-inv")!.dependsOn).toEqual([]);
    expect(byId.get("s-vuln")!.dependsOn).toEqual([]);
    expect(byId.get("s-reach")!.dependsOn).toEqual(["s-inv", "s-vuln"]);
    expect(byId.get("s-impact")!.dependsOn).toEqual(["s-inv", "s-vuln"]);
    expect(byId.get("s-invest")!.dependsOn).toEqual(["s-reach", "s-impact"]);
    const valid = byId.get("s-valid")!;
    expect(valid.sandboxValidation).toBe(true);
    expect(valid.output.key).toBe("validation_1");
    expect(byId.get("s-report")!.dependsOn).toEqual(["s-invest", "s-valid"]);

    // The replan is a targeted reachability task, then investigator and report again.
    // The second plan.created carries the merged plan; the replan is the subtasks that are new.
    const oldIds = new Set(plan.map((s) => s.id));
    const replanned = created[1]!.subtasks.filter((s) => !oldIds.has(s.id));
    expect(replanned.map((s) => s.roleHint)).toEqual([
      "reachability",
      "investigator",
      "investigator",
      "executor",
    ]);
  }, 60000);

  it("each role produces schema-valid output whose claims cite recorded evidence", async () => {
    const r = await run();
    expectWellFormed(r);

    const written = Object.fromEntries(of(r, "blackboard.written").map((e) => [e.key, e.entry]));
    expect(InventoryResultSchema.safeParse(written["inventory"]!.value).success).toBe(true);
    expect(VulnerabilityResearchSchema.safeParse(written["vulns"]!.value).success).toBe(true);
    expect(ReachabilityResultSchema.safeParse(written["reachability_2"]!.value).success).toBe(true);
    expect(ImpactResultSchema.safeParse(written["upgrade_impact"]!.value).success).toBe(true);
    expect(InvestigatorResultSchema.safeParse(written["findings_2"]!.value).success).toBe(true);
    expect(ValidationStepResultSchema.safeParse(written["validation_2"]!.value).success).toBe(true);

    // Recorded evidence: every tool-citing claim names a tool call the trace recorded,
    // and every blackboard-citing claim names a key that was written.
    const recordedCalls = new Set(of(r, "tool.result").map((e) => e.callId));
    const recordedKeys = new Set(Object.keys(written));
    for (const entry of Object.values(written)) {
      for (const ev of entry.evidence) {
        if (!ev.claim) continue;
        if (ev.toolCallId) {
          expect(
            recordedCalls.has(ev.toolCallId),
            `claim "${ev.claim}" cites ${ev.toolCallId}, which the trace never recorded`,
          ).toBe(true);
        }
        if (ev.source.startsWith("blackboard:")) {
          expect(
            recordedKeys.has(ev.source.slice("blackboard:".length)),
            `claim "${ev.claim}" cites ${ev.source}, which was never written`,
          ).toBe(true);
        }
      }
    }
  }, 60000);

  it("reports one REACHABLE and one NOT_REACHABLE finding with evidence", async () => {
    const r = await run();
    const findings = InvestigatorResultSchema.parse(r.blackboard["findings_2"]!.value).findings;
    expect(findings.map((f) => [f.dependency, f.reachability.verdict])).toEqual([
      ["qs", "REACHABLE"],
      ["unused-vuln-lib", "NOT_REACHABLE"],
    ]);
    for (const f of findings) {
      expect(
        InvestigationFinding.safeParse({ ...f, sandbox: null, critic: "PENDING" }).success,
      ).toBe(true);
      expect(f.claimIds.length).toBeGreaterThan(0);
    }
    const qs = findings.find((f) => f.dependency === "qs")!;
    expect(qs.recommendedAction).toBe("HUMAN_REVIEW");
    const unused = findings.find((f) => f.dependency === "unused-vuln-lib")!;
    expect(unused.recommendedAction).toBe("MONITOR");
  }, 60000);

  it("runs the critic rejection, targeted reachability replan, and accept cycle", async () => {
    const r = await run();
    const rejected = of(r, "critic.verdict").filter(
      (e) => e.subtaskId === "s-invest" && e.verdict === "rejected",
    );
    expect(rejected).toHaveLength(2);
    expect(of(r, "slot.rejected")).toHaveLength(1);
    expect(of(r, "replan.triggered")).toHaveLength(1);
    expect(of(r, "replan.triggered")[0]!.reason).toContain("Reachability analysis");
    const accepted = of(r, "critic.verdict").filter(
      (e) => e.subtaskId === "s-invest2" && e.verdict === "accepted",
    );
    expect(accepted).toHaveLength(1);
  }, 60000);

  it("validates remediations with the code sandbox and writes the report", async () => {
    const r = await run();
    // The code validator ran without an agent slot: the trace names role validator.
    const started = of(r, "sandbox.started");
    const finished = of(r, "sandbox.finished");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ findingId: "f-qs", dependency: "qs" });
    expect(finished).toHaveLength(1);
    expect(finished[0]!.validation.verdict).toBe("NOT_RUN");
    // No agent slot ran the validation step: it is code-driven, not an LLM slot.
    expect(of(r, "agent.started").filter((e) => e.subtaskId === "s-valid2")).toEqual([]);

    expect(r.reportKey).toBe("report");
    const report = r.blackboard["report"]!.value as { summary: string; items: unknown[] };
    expect(report.summary.toLowerCase()).toContain("reachable");
    expect(report.items).toHaveLength(2);
  }, 60000);
});

describe("committed investigation trace", () => {
  it("traces/investigation-roles.jsonl replays the REACHABLE / NOT_REACHABLE story", () => {
    const file = path.resolve(FIXTURE, "../../../../../traces/investigation-roles.jsonl");
    if (!fs.existsSync(file)) return; // recorded with scripts/record-investigation.mjs
    const events = parseTrace(fs.readFileSync(file, "utf-8"));
    expect(events[0]!.kind).toBe("run.started");
    const last = events.at(-1)!;
    expect(last.kind === "run.finished" && last.status).toBe("completed");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
    for (const e of events) expect(TraceEventSchema.safeParse(e).success).toBe(true);
    const verdicts = events.filter((e) => e.kind === "critic.verdict");
    expect(verdicts.some((e) => e.kind === "critic.verdict" && e.verdict === "rejected")).toBe(
      true,
    );
    expect(verdicts.some((e) => e.kind === "critic.verdict" && e.verdict === "accepted")).toBe(
      true,
    );
    const written = events.filter((e) => e.kind === "blackboard.written");
    const findingsKey = written.some(
      (e) => e.kind === "blackboard.written" && e.key === "findings_2",
    );
    expect(findingsKey).toBe(true);
  });
});
