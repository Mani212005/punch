import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Plan } from "@punch/shared";
import { PlanValidationError, planBrief, replan, validatePlan } from "./planner.js";
import { deps, entry, result, scriptedAdapter } from "./roles/test-helpers.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../../../fixtures/planner/plans.json", import.meta.url), "utf8"),
) as { brief: string; valid: unknown; cycle: unknown; orphanInput: unknown };

const parse = (raw: unknown): Plan => Plan.parse(raw);

describe("validatePlan", () => {
  it("accepts the recorded DAG", () => {
    expect(validatePlan(parse(fixtures.valid))).toEqual([]);
  });

  it("reports a cycle", () => {
    expect(validatePlan(parse(fixtures.cycle)).join(" ")).toMatch(/cycle among: s1, s2/);
  });

  it("reports an input no upstream subtask produces", () => {
    expect(validatePlan(parse(fixtures.orphanInput))).toEqual([
      expect.stringMatching(/reads "vulns"/),
    ]);
  });

  it("reports duplicate ids, duplicate keys, unknown and self dependencies", () => {
    const plan = parse({
      subtasks: [
        {
          id: "a",
          title: "t",
          description: "d",
          dependsOn: ["a", "zz"],
          roleHint: "researcher",
          output: { key: "k" },
        },
        {
          id: "a",
          title: "t",
          description: "d",
          dependsOn: [],
          roleHint: "researcher",
          output: { key: "k" },
        },
      ],
    });
    const errors = validatePlan(plan).join("\n");
    expect(errors).toMatch(/duplicate subtask id "a"/);
    expect(errors).toMatch(/output key "k" is produced by both/);
    expect(errors).toMatch(/depends on itself/);
    expect(errors).toMatch(/unknown subtask "zz"/);
  });

  it("treats external keys as available", () => {
    expect(validatePlan(parse(fixtures.orphanInput), { externalKeys: ["vulns"] })).toEqual([]);
  });
});

describe("planBrief", () => {
  it("turns the fixture brief into a valid DAG and fills default schemas", async () => {
    const adapter = scriptedAdapter([() => result(fixtures.valid)]);
    const plan = await planBrief(deps(adapter, "planner-a"), { brief: fixtures.brief });
    expect(plan.subtasks.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(validatePlan(plan)).toEqual([]);
    const report = plan.subtasks.find((s) => s.id === "s4")!;
    expect(report.output.schema).toMatchObject({ required: ["summary", "items", "unknowns"] });
    expect(adapter.inputs[0]!.tools).toEqual([]);
    expect(adapter.inputs[0]!.role).toBe("planner");
    expect(adapter.inputs[0]!.task).toContain(fixtures.brief);
  });

  it("corrects an invalid DAG in one round", async () => {
    const adapter = scriptedAdapter([() => result(fixtures.cycle), () => result(fixtures.valid)]);
    const plan = await planBrief(deps(adapter), { brief: fixtures.brief });
    expect(validatePlan(plan)).toEqual([]);
    expect(adapter.inputs).toHaveLength(2);
    expect(adapter.inputs[1]!.task).toMatch(/previous plan was invalid[\s\S]*dependency cycle/);
  });

  it("fails when the correction is still invalid", async () => {
    const adapter = scriptedAdapter([
      () => result(fixtures.cycle),
      () => result(fixtures.orphanInput),
    ]);
    const err = await planBrief(deps(adapter), { brief: fixtures.brief }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanValidationError);
    expect((err as PlanValidationError).errors[0]).toMatch(/reads "vulns"/);
    expect(adapter.inputs).toHaveLength(2);
  });

  it("counts a schema-invalid result as an invalid plan", async () => {
    const adapter = scriptedAdapter([() => result({ subtasks: [] }), () => result(fixtures.valid)]);
    const plan = await planBrief(deps(adapter), { brief: fixtures.brief });
    expect(plan.subtasks).toHaveLength(4);
    expect(adapter.inputs[1]!.task).toMatch(/did not match the schema/);
  });
});

describe("replan", () => {
  const original = parse(fixtures.valid);
  const alternative = {
    subtasks: [
      {
        id: "s2b",
        title: "Advisory-only lookup",
        description: "Use GitHub Advisory.",
        dependsOn: ["s1"],
        roleHint: "researcher",
        output: { key: "vulns_alt" },
        inputKeys: ["inventory"],
      },
      {
        id: "s4",
        title: "Write report",
        description: "Report.",
        dependsOn: ["s2b"],
        roleHint: "executor",
        output: { key: "report" },
        inputKeys: ["vulns_alt"],
      },
    ],
  };

  it("replaces the failed subtask and its dependents and keeps the rest", async () => {
    const adapter = scriptedAdapter([() => result(alternative)]);
    const plan = await replan(deps(adapter), {
      brief: fixtures.brief,
      plan: original,
      failedSubtaskId: "s2",
      reason: "OSV permanently unavailable",
      blackboard: { inventory: entry({ key: "inventory", value: { dependencies: [] } }) },
    });
    expect(plan.subtasks.map((s) => s.id)).toEqual(["s1", "s2b", "s4"]);
    expect(adapter.inputs[0]!.task).toContain("s2, s3, s4");
    expect(validatePlan(plan, { externalKeys: ["inventory"] })).toEqual([]);
  });

  it("rejects replacement keys that already exist on the blackboard", async () => {
    const clash = {
      subtasks: [
        { ...alternative.subtasks[0], output: { key: "inventory" } },
        alternative.subtasks[1],
      ],
    };
    const adapter = scriptedAdapter([() => result(clash), () => result(alternative)]);
    const plan = await replan(deps(adapter), {
      brief: fixtures.brief,
      plan: original,
      failedSubtaskId: "s2",
      reason: "x",
      blackboard: { inventory: entry({ key: "inventory" }) },
    });
    expect(plan.subtasks).toHaveLength(3);
    expect(adapter.inputs[1]!.task).toMatch(/keys are never overwritten/);
  });
});
