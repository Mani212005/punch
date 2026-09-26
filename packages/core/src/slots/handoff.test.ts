import { Handoff } from "@punch/shared";
import { describe, expect, it } from "vitest";
import {
  AttemptLog,
  buildHandoff,
  describeRecovered,
  filesInspectedBy,
  handoffPrompt,
  summarizeHandoff,
} from "./handoff.js";
import { computeInputHash } from "../tools/cache.js";

const subtask = {
  id: "s1",
  title: "t",
  description: "d",
  dependsOn: [],
  roleHint: "researcher" as const,
  output: { key: "k" },
  inputKeys: [],
  status: "running" as const,
};

function logWithWork(): AttemptLog {
  const log = new AttemptLog();
  const call = (callId: string, tool: string, input: unknown, ok: boolean, output: unknown) => {
    log.observe({ type: "tool_call", callId, tool, input });
    log.observe({ type: "tool_result", callId, tool, ok, output });
  };
  call("c1", "github_get_contents", { owner: "o", repo: "r", path: "package.json" }, true, {
    a: 1,
  });
  call("c2", "github_get_contents", { owner: "o", repo: "r", path: "lock.json" }, true, { b: 2 });
  call("c3", "osv_query", { package: "qs" }, true, { vulns: [] });
  call("c4", "npm_latest", { package: "qs" }, false, "boom");
  call("c5", "read_blackboard", { key: "inventory" }, true, { value: 1 });
  log.observe({ type: "text", text: "thinking" });
  log.observe({ type: "text", text: "found two files" });
  return log;
}

describe("handoff packet (plan.md 2.4)", () => {
  const handoff = buildHandoff({
    subtask,
    reason: { kind: "operator_kill", detail: "killed" },
    predecessor: { agentId: "a", displayName: "A", turnsUsed: 3, usdUsed: 0.2 },
    inputs: {},
    log: logWithWork(),
    budget: { stepsRemaining: 4, usdRemaining: 1, msRemaining: 9 },
    now: 1000,
  });

  it("validates against the shared schema", () => {
    expect(Handoff.safeParse(handoff).success).toBe(true);
  });

  it("carries only successful tool calls, keyed by the cache hash", () => {
    expect(handoff.cachedToolResults.map((c) => c.tool)).toEqual([
      "github_get_contents",
      "github_get_contents",
      "osv_query",
      "read_blackboard",
    ]);
    expect(handoff.cachedToolResults[2]!.inputHash).toBe(
      computeInputHash("osv_query", { package: "qs" }),
    );
  });

  it("lists files read, evidence records and the last notes", () => {
    expect(handoff.filesInspected).toEqual(["package.json", "lock.json"]);
    expect(handoff.partialNotes).toBe("found two files");
    expect(handoff.evidenceRecords.map((e) => [e.kind, e.ref, e.tool])).toEqual([
      ["file", "package.json", "github_get_contents"],
      ["file", "lock.json", "github_get_contents"],
      ["api_response", "c3", "osv_query"],
    ]);
    expect(describeRecovered(handoff)).toBe("2 files, 2 API responses, 3 evidence records");
  });

  it("summarizes for the trace and instructs the replacement not to restart", () => {
    expect(summarizeHandoff(handoff)).toMatchObject({
      cachedResultCount: 4,
      filesInspectedCount: 2,
      evidenceRecordCount: 3,
      partialNotes: "found two files",
    });
    const prompt = handoffPrompt(handoff);
    expect(prompt).toContain("SAME output key");
    expect(prompt).toContain("was killed by the operator");
    expect(prompt).toContain("Do not restart");
  });

  it("an explicit partialNotes and critic findings override the log", () => {
    const h = buildHandoff({
      subtask,
      reason: { kind: "rejected", detail: "r" },
      predecessor: { agentId: "a", displayName: "A", turnsUsed: 0, usdUsed: 0 },
      inputs: {},
      log: new AttemptLog(),
      partialNotes: "Rejected draft: {}",
      criticFindings: [{ claim: "c", problem: "p", severity: "blocker" }],
      budget: { stepsRemaining: 0, usdRemaining: 0, msRemaining: 0 },
      now: 0,
    });
    expect(h.partialNotes).toBe("Rejected draft: {}");
    expect(handoffPrompt(h)).toContain("The critic rejected");
  });

  it("filesInspectedBy ignores non-file tools", () => {
    expect(
      filesInspectedBy([{ callId: "x", tool: "osv_query", input: { path: "nope" }, ok: true }]),
    ).toEqual([]);
  });
});
