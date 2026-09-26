import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@punch/shared";
import type { InvestigatorResult } from "./investigator.js";
import { planBrief } from "../planner.js";
import { PLANNER_SYSTEM } from "../planner.js";
import {
  IMPACT_RESULT_JSON_SCHEMA,
  assertNoInventedPercentages,
  runImpact,
} from "./impact.js";
import { assertRecommendationRules, recommendAction, runInvestigator } from "./investigator.js";
import { INVENTORY_RESULT_JSON_SCHEMA, runInventory } from "./inventory.js";
import { REACHABILITY_RESULT_JSON_SCHEMA, assertReachabilityVerdicts, runReachability } from "./reachability.js";
import { VULNERABILITY_RESEARCH_JSON_SCHEMA } from "./researcher.js";
import { ValidationStepResultSchema, runValidationStep } from "./validator.js";
import { toolsForRole } from "./common.js";
import { deps, result, scriptedAdapter, subtask } from "./test-helpers.js";

/** Tool events the ledger records, so evidence citing the call id is verifiable. */
const toolEvents = (callId: string, tool: string, output: unknown): AgentEvent[] => [
  { type: "tool_call", callId, tool, input: {} },
  { type: "tool_result", callId, tool, ok: true, output },
];

const inventoryValue = {
  repository: "vuln-shop",
  inventory: {
    direct: [{ name: "qs", specifier: "6.5.2", isDev: false, type: "prod" }],
    allResolved: { qs: "6.5.2" },
    manifestFound: true,
    lockfileType: "none",
  },
  dependencyEdges: [],
};

const reachabilityValue = {
  assessments: [
    {
      dependency: "qs",
      version: "6.5.2",
      advisoryIds: ["CVE-2022-24999"],
      reachability: {
        verdict: "REACHABLE",
        exists: "yes",
        exposed: "yes",
        exploitable: "yes",
        affectedSymbols: ["parse"],
        claimIds: ["c1"],
        summary: "qs.parse is called on a route.",
      },
    },
    {
      dependency: "unused-vuln-lib",
      version: "1.0.0",
      advisoryIds: ["CVE-2024-0001"],
      reachability: {
        verdict: "NOT_REACHABLE",
        exists: "yes",
        exposed: "no",
        exploitable: "no",
        affectedSymbols: ["compile"],
        claimIds: ["c2"],
        summary: "Never imported.",
      },
    },
  ],
};

const impactValue = {
  impacts: [
    {
      dependency: "qs",
      from: "6.5.2",
      to: "6.13.0",
      semverChange: "minor",
      releaseNotes: "No breaking changes.",
      removedApisInUse: [],
      impact: { level: "LOW", detectedRisks: [], unknowns: [], claimIds: ["c1"] },
    },
  ],
};

const investigatorValue: InvestigatorResult = {
  findings: [
    {
      id: "f-qs",
      dependency: "qs",
      version: "6.5.2",
      advisoryIds: ["CVE-2022-24999"],
      severity: "HIGH",
      reachability: {
        verdict: "REACHABLE",
        exists: "yes",
        exposed: "yes",
        exploitable: "yes",
        affectedSymbols: ["parse"],
        claimIds: ["c1"],
        summary: "Reachable.",
      },
      upgrade: { from: "6.5.2", to: "6.13.0" },
      upgradeImpact: { level: "LOW", detectedRisks: [], unknowns: [], claimIds: ["c1"] },
      sandbox: null,
      critic: "PENDING",
      recommendedAction: "HUMAN_REVIEW",
      reasoning: "No sandbox validation yet.",
      claimIds: ["c1"],
    },
  ],
  remediations: [{ findingId: "f-qs", dependency: "qs", from: "6.5.2", to: "6.13.0" }],
};

describe("inventory", () => {
  it("returns a schema-valid draft citing recorded tool calls", async () => {
    const adapter = scriptedAdapter([
      () => [
        ...toolEvents("call_1", "parse_dependency_inventory", { direct: [{ name: "qs" }] }),
        ...result({
          value: inventoryValue,
          evidence: [
            {
              claim: "qs 6.5.2 is declared",
              source: "parse_dependency_inventory",
              toolCallId: "call_1",
              quote: "qs",
            },
          ],
        }),
      ],
    ]);
    const draft = await runInventory(deps(adapter, "inv-a"), {
      subtask: subtask({ roleHint: "inventory", output: { key: "inventory" } }),
      inputs: {},
    });
    expect(draft.status).toBe("ok");
    const tools = adapter.inputs[0]!.tools.map((t) => t.name);
    expect(tools).toContain("parse_dependency_inventory");
    expect(tools).toContain("analyze_import_graph");
    expect(tools.every((t) => t !== "github_create_issue")).toBe(true);
  });

  it("rejects ok results with uncited claims", async () => {
    const adapter = scriptedAdapter([
      () =>
        result({
          value: inventoryValue,
          evidence: [{ claim: "qs is present", source: "memory" }],
        }),
    ]);
    await expect(
      runInventory(deps(adapter), {
        subtask: subtask({ roleHint: "inventory", output: { key: "inventory" } }),
        inputs: {},
      }),
    ).rejects.toThrow(/toolCallId/);
  });
});

describe("reachability", () => {
  const st = () => subtask({ roleHint: "reachability", output: { key: "reachability" } });

  it("accepts REACHABLE and NOT_REACHABLE verdicts with cited searches", async () => {
    const adapter = scriptedAdapter([
      () => [
        ...toolEvents("call_1", "find_call_sites", { callSites: ["src/server.js"] }),
        ...toolEvents("call_2", "analyze_import_graph", { used: ["qs"] }),
        ...result({
          value: reachabilityValue,
          evidence: [
            {
              claim: "qs.parse is called",
              source: "find_call_sites",
              toolCallId: "call_1",
              quote: "src/server.js",
            },
            {
              claim: "unused-vuln-lib is never imported",
              source: "analyze_import_graph",
              toolCallId: "call_2",
              quote: "no imports",
            },
          ],
        }),
      ],
    ]);
    const draft = await runReachability(deps(adapter, "reach-a"), { subtask: st(), inputs: {} });
    expect(draft.status).toBe("ok");
    expect(adapter.inputs[0]!.tools.map((t) => t.name)).toContain("find_call_sites");
  });

  it("rejects verdicts that contradict their levels", () => {
    expect(() =>
      assertReachabilityVerdicts({
        assessments: [
          {
            dependency: "qs",
            version: "1.0.0",
            advisoryIds: ["CVE-1"],
            reachability: {
              verdict: "NOT_REACHABLE",
              exists: "yes",
              exposed: "yes",
              exploitable: "no",
              affectedSymbols: [],
              claimIds: [],
              summary: "contradiction",
            },
          },
        ],
      }),
    ).toThrow(/contradicts/);
  });

  it("rejects claims citing tool calls that never happened", async () => {
    const adapter = scriptedAdapter([
      () =>
        result({
          value: reachabilityValue,
          evidence: [
            { claim: "qs.parse is called", source: "find_call_sites", toolCallId: "ghost" },
          ],
        }),
    ]);
    await expect(runReachability(deps(adapter), { subtask: st(), inputs: {} })).rejects.toThrow(
      /no recorded tool call/,
    );
  });
});

describe("impact", () => {
  const st = () => subtask({ roleHint: "impact", output: { key: "upgrade_impact" } });

  it("accepts LOW/MEDIUM/HIGH with evidence and forbids invented percentages", async () => {
    const adapter = scriptedAdapter([
      () => [
        ...toolEvents("call_1", "get_release_notes", { notes: "no breaking changes" }),
        ...result({
          value: impactValue,
          evidence: [
            {
              claim: "no breaking changes",
              source: "get_release_notes",
              toolCallId: "call_1",
              quote: "no breaking changes",
            },
          ],
        }),
      ],
    ]);
    const draft = await runImpact(deps(adapter, "impact-a"), { subtask: st(), inputs: {} });
    expect(draft.status).toBe("ok");
  });

  it("rejects guessed safety percentages", () => {
    expect(() => assertNoInventedPercentages({ level: "87% safe" })).toThrow(/percentage/);
    expect(() =>
      assertNoInventedPercentages({ impact: { level: "LOW", unknowns: [] } }),
    ).not.toThrow();
  });
});

describe("investigator", () => {
  const st = () => subtask({ roleHint: "investigator", output: { key: "findings" } });

  it("synthesizes findings from blackboard reads with rule-following recommendations", async () => {
    const adapter = scriptedAdapter([
      () => [
        ...toolEvents("call_1", "read_blackboard", { key: "reachability" }),
        ...result({
          value: investigatorValue,
          evidence: [{ claim: "qs is reachable", source: "blackboard:reachability" }],
        }),
      ],
    ]);
    const draft = await runInvestigator(deps(adapter, "inv-a"), { subtask: st(), inputs: {} });
    expect(draft.status).toBe("ok");
    expect(adapter.inputs[0]!.tools.map((t) => t.name).sort()).toEqual([
      "get_tool_result",
      "list_blackboard",
      "read_blackboard",
    ]);
  });

  it("rejects claims that do not cite the blackboard", async () => {
    const adapter = scriptedAdapter([
      () =>
        result({
          value: investigatorValue,
          evidence: [{ claim: "qs is reachable", source: "memory" }],
        }),
    ]);
    await expect(runInvestigator(deps(adapter), { subtask: st(), inputs: {} })).rejects.toThrow(
      /blackboard:/,
    );
  });
});

describe("recommendAction", () => {
  const cases: Array<[Parameters<typeof recommendAction>[0], string]> = [
    [{ severity: "HIGH", reachability: "REACHABLE", impact: "LOW", sandbox: "PASS" }, "UPGRADE"],
    [{ severity: "HIGH", reachability: "REACHABLE", impact: "LOW", sandbox: null }, "HUMAN_REVIEW"],
    [{ severity: "HIGH", reachability: "REACHABLE", impact: "LOW", sandbox: "NOT_RUN" }, "HUMAN_REVIEW"],
    [{ severity: "HIGH", reachability: "REACHABLE", impact: "LOW", sandbox: "FAIL" }, "HUMAN_REVIEW"],
    [{ severity: "HIGH", reachability: "REACHABLE", impact: "HIGH", sandbox: "PASS" }, "HUMAN_REVIEW"],
    [{ severity: "HIGH", reachability: "UNKNOWN", impact: "LOW", sandbox: null }, "HUMAN_REVIEW"],
    [{ severity: "LOW", reachability: "NOT_REACHABLE", impact: "LOW", sandbox: null }, "MONITOR"],
    [{ severity: "MEDIUM", reachability: "NOT_REACHABLE", impact: "LOW", sandbox: null }, "NO_ACTION"],
    [{ severity: "LOW", reachability: "UNKNOWN", impact: "LOW", sandbox: null }, "HUMAN_REVIEW"],
  ];
  for (const [input, expected] of cases) {
    it(`${input.reachability}/${input.severity}/${input.sandbox ?? "no-sandbox"} -> ${expected}`, () => {
      expect(recommendAction(input)).toBe(expected);
    });
  }

  it("flags findings that break the rules", () => {
    expect(() =>
      assertRecommendationRules({
        findings: [{ ...investigatorValue.findings[0]!, recommendedAction: "UPGRADE" as const }],
        remediations: [],
      }),
    ).toThrow(/breaks the rules/);
  });
});

describe("validator step", () => {
  it("records NOT_RUN without a checkout and emits sandbox events", async () => {
    const seen: Record<string, unknown>[] = [];
    const draft = await runValidationStep({
      subtaskId: "s-valid",
      inputs: {},
      emit: (e) => seen.push(e),
    });
    expect(draft.status).toBe("ok");
    expect(ValidationStepResultSchema.safeParse(draft.value).success).toBe(true);
    expect(draft.value).toEqual({ validations: [] });
    expect(seen).toEqual([]);
  });

  it("validates each candidate remediation through the E5 validator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "punch-valid-"));
    try {
      const seen: Record<string, unknown>[] = [];
      const inputs = {
        findings: {
          key: "findings",
          version: 1,
          status: "ok",
          value: investigatorValue,
          evidence: [],
          writtenBy: { role: "investigator", agentId: "a" },
          ts: 1,
        },
      } as never;
      const draft = await runValidationStep({
        subtaskId: "s-valid",
        inputs,
        repoDir: dir,
        emit: (e) => seen.push(e),
        run: (async (options: { trace: unknown }) => {
          const trace = options.trace as { write(e: unknown): unknown };
          await trace.write({
            kind: "sandbox.started",
            findingId: "f-qs",
            dependency: "qs",
            from: "6.5.2",
            to: "6.13.0",
            isolation: "none",
          });
          const validation = {
            isolation: "none",
            note: "not run (no isolation available)",
            baseline: null,
            candidate: null,
            newFailures: [],
            fixedFailures: [],
            changedFiles: [],
            verdict: "NOT_RUN",
            evidenceIds: ["ev-1"],
          } as const;
          await trace.write({ kind: "sandbox.finished", findingId: "f-qs", validation });
          return {
            validation,
            evidence: [
              {
                id: "ev-1",
                kind: "sandbox_run",
                ref: "sandbox:f-qs:finished",
                excerpt: "not run (no isolation available)",
                fetchedAt: 1,
                tool: "sandbox",
              },
            ],
          };
        }) as never,
      });
      expect(draft.value).toMatchObject({
        validations: [{ findingId: "f-qs", validation: { verdict: "NOT_RUN" } }],
      });
      expect(draft.evidence[0]!.claim).toContain("NOT_RUN");
      expect(seen.map((e) => e["kind"])).toEqual(["sandbox.started", "sandbox.finished"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("role tool sets", () => {
  it("gives the new roles reversible tools only, and the investigator reads only", () => {
    for (const role of ["inventory", "reachability", "impact"] as const) {
      const tools = toolsForRole(role);
      expect(tools.every((t) => !t.irreversible)).toBe(true);
      expect(tools.map((t) => t.name)).toContain("analyze_import_graph");
    }
    expect(toolsForRole("investigator").map((t) => t.name).sort()).toEqual([
      "get_tool_result",
      "list_blackboard",
      "read_blackboard",
    ]);
  });
});

describe("planner investigation template", () => {
  const template = {
    subtasks: [
      {
        id: "s-inv",
        title: "t",
        description: "d",
        dependsOn: [],
        roleHint: "inventory",
        output: { key: "inventory" },
      },
      {
        id: "s-vuln",
        title: "t",
        description: "d",
        dependsOn: [],
        roleHint: "researcher",
        output: { key: "vulns" },
      },
      {
        id: "s-reach",
        title: "t",
        description: "d",
        dependsOn: ["s-inv", "s-vuln"],
        roleHint: "reachability",
        output: { key: "reachability" },
        inputKeys: ["inventory", "vulns"],
      },
      {
        id: "s-impact",
        title: "t",
        description: "d",
        dependsOn: ["s-inv", "s-vuln"],
        roleHint: "impact",
        output: { key: "upgrade_impact" },
        inputKeys: ["inventory", "vulns"],
      },
      {
        id: "s-invest",
        title: "t",
        description: "d",
        dependsOn: ["s-reach", "s-impact"],
        roleHint: "investigator",
        output: { key: "findings" },
        inputKeys: ["inventory", "vulns", "reachability", "upgrade_impact"],
      },
      {
        id: "s-valid",
        title: "t",
        description: "d",
        dependsOn: ["s-invest"],
        roleHint: "investigator",
        output: { key: "validation_1" },
        inputKeys: ["findings"],
        sandboxValidation: true,
      },
      {
        id: "s-report",
        title: "t",
        description: "d",
        dependsOn: ["s-invest", "s-valid"],
        roleHint: "executor",
        output: { key: "report" },
        inputKeys: ["findings", "validation_1"],
      },
    ],
  };

  it("fills per-role default schemas, including the code validation step", async () => {
    const adapter = scriptedAdapter([() => result(template)]);
    const plan = await planBrief(deps(adapter, "planner-a"), { brief: "b" });
    const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
    const props = (id: string) =>
      (byId.get(id)!.output.schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props("s-inv"))).toContain("inventory");
    expect(Object.keys(props("s-vuln"))).toContain("vulnerabilities");
    expect(Object.keys(props("s-reach"))).toContain("assessments");
    expect(Object.keys(props("s-impact"))).toContain("impacts");
    expect(Object.keys(props("s-invest"))).toContain("findings");
    expect(Object.keys(props("s-valid"))).toContain("validations");
    expect(Object.keys(props("s-report"))).toContain("unknowns");
  });

  it("teaches the template waves and the code validation marker", () => {
    expect(PLANNER_SYSTEM).toContain("sandboxValidation");
    expect(PLANNER_SYSTEM).toContain("reachability");
    expect(PLANNER_SYSTEM).toContain("investigator");
    expect(PLANNER_SYSTEM).toContain("in parallel");
  });

  it("exposes the role JSON schemas for the planner defaults", () => {
    for (const schema of [
      INVENTORY_RESULT_JSON_SCHEMA,
      VULNERABILITY_RESEARCH_JSON_SCHEMA,
      REACHABILITY_RESULT_JSON_SCHEMA,
      IMPACT_RESULT_JSON_SCHEMA,
    ]) {
      expect(schema).toMatchObject({ type: "object", properties: expect.anything() });
    }
  });
});
