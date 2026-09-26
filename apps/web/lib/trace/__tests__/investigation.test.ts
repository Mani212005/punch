import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TraceEvent } from "@punch/shared";
import { createInitialBoardState, traceReducer } from "../index.js";
import { findInvestigationReport } from "../investigation.js";

const tracePath = resolve(__dirname, "../../../../../traces/investigation.jsonl");

function loadTrace(): TraceEvent[] {
  return readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => TraceEvent.parse(JSON.parse(line)));
}

describe("investigation trace on the reducer", () => {
  const events = loadTrace();
  const state = events.reduce(traceReducer, createInitialBoardState());

  it("is a valid trace with claims, sandbox events and a takeover", () => {
    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of [
      "claim.recorded",
      "sandbox.finished",
      "slot.replaced",
      "approval.requested",
    ]) {
      expect(kinds.has(kind as TraceEvent["kind"])).toBe(true);
    }
  });

  it("builds the evidence ledger from claim.* and evidence.recorded", () => {
    expect(Object.keys(state.claims).length).toBeGreaterThanOrEqual(9);
    expect(state.claims["c-6"].claim.status).toBe("verified");
    expect(state.claims["c-6"].claim.verifier?.role).toBe("critic");
    expect(state.claims["c-9"].claim.verifier?.role).toBe("validator");
    expect(state.evidence["ev-9"].evidence.kind).toBe("sandbox_run");
    expect(state.evidence["ev-9"].role).toBe("validator");
  });

  it("builds the sandbox comparison with isolation and verdict", () => {
    const run = state.sandbox["f-1"];
    expect(run.isolation).toBe("docker");
    expect(run.steps).toHaveLength(6);
    expect(run.validation?.verdict).toBe("PASS");
    expect(run.validation?.candidate?.counts?.passed).toBe(48);
  });

  it("records the takeover and the remediation approval", () => {
    expect(state.takeover.history.length + (state.takeover.active ? 1 : 0)).toBeGreaterThan(0);
    expect(state.remediations).toHaveLength(1);
    expect(state.approvals[0].approvalId).toBe("ap-1");
    expect(state.approvals[0].status).toBe("granted");
  });

  it("finds the section-8 report on the blackboard", () => {
    const report = findInvestigationReport(state.blackboard);
    expect(report?.summary.relevantReachable).toBe(1);
    expect(report?.findings.map((f) => f.reachability.verdict)).toEqual([
      "REACHABLE",
      "NOT_REACHABLE",
    ]);
  });

  it("only shows slots for roles that appear in the trace", () => {
    expect(state.seenRoles).toContain("reachability");
    expect(state.seenRoles).not.toContain("orchestrator");
    const clean = readFileSync(resolve(__dirname, "../../../../../traces/clean.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => TraceEvent.parse(JSON.parse(l)))
      .reduce(traceReducer, createInitialBoardState());
    expect(clean.seenRoles).not.toContain("impact");
  });
});
