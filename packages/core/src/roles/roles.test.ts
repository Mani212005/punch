import { describe, expect, it } from "vitest";
import type { AgentEvent, TraceEvent } from "@punch/shared";
import { Blackboard } from "../blackboard.js";
import { DenyAllApprovalGate } from "../approval.js";
import type { Jev } from "../router/jev.js";
import type { TraceEventInput } from "../trace/writer.js";
import {
  ToolLedger,
  RoleRunError,
  commitDraft,
  createRoleToolExecutor,
  toolsForRole,
  type Draft,
} from "./common.js";
import { reviewDraft } from "./critic.js";
import { runExecutor } from "./executor.js";
import { runResearcher } from "./researcher.js";
import { produceWithReview } from "./review.js";
import { deps, entry, result, scriptedAdapter, subtask } from "./test-helpers.js";
import { readFileSync } from "node:fs";

const qs = JSON.parse(
  readFileSync(new URL("../../../../fixtures/npm/qs_metadata.json", import.meta.url), "utf8"),
) as { "dist-tags": { latest: string } };
const QS_LATEST = qs["dist-tags"].latest; // 6.13.0

/** Researcher script: one npm tool call (recorded fixture output), then a write_result citing it. */
const researcherScript =
  (claimedVersion: string, opts: { toolCallId?: string } = {}) =>
  async (
    _input: unknown,
    exec: (n: string, i: unknown, id: string) => Promise<unknown>,
  ): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [
      {
        type: "tool_call",
        callId: "call_1",
        tool: "get_package_metadata",
        input: { package: "qs" },
      },
    ];
    const output = await exec("get_package_metadata", { package: "qs" }, "call_1");
    events.push({
      type: "tool_result",
      callId: "call_1",
      tool: "get_package_metadata",
      ok: true,
      output,
    });
    events.push(
      ...result({
        value: { package: "qs", latest: claimedVersion },
        evidence: [
          {
            claim: `qs latest version is ${claimedVersion}`,
            source: "npm registry",
            toolCallId: opts.toolCallId ?? "call_1",
            quote: `dist-tags.latest = ${claimedVersion}`,
          },
        ],
      }),
    );
    return events;
  };

const npmOutput = { name: "qs", "dist-tags": qs["dist-tags"] };
const npmExecutor = async () => npmOutput;

/** Jev double: supported iff the recorded tool output (not the agent's own quote) holds the claimed version. */
const fakeJev: Pick<Jev, "precheckClaims"> = {
  async precheckClaims(claims) {
    return Object.fromEntries(
      claims.map((c) => {
        const version = /\d+\.\d+\.\d+/.exec(c.claim)?.[0];
        const recorded = c.evidence.split("Recorded output")[1] ?? "";
        return [c.id, version && recorded.includes(version) ? 0.95 : 0.04];
      }),
    );
  },
};

const acceptingCritic = () =>
  scriptedAdapter([() => result({ verdict: "accepted", findings: [] })]);

describe("researcher", () => {
  it("writes an evidence-linked entry that passes the critic", async () => {
    const board = new Blackboard({ runId: "r" });
    const ledger = new ToolLedger();
    const adapter = scriptedAdapter([researcherScript(QS_LATEST)], npmExecutor);
    const st = subtask();
    const draft = await runResearcher(deps(adapter, "researcher-a", ledger), {
      subtask: st,
      inputs: {},
    });

    expect(draft.value).toEqual({ package: "qs", latest: QS_LATEST });
    expect(draft.status).toBe("ok");
    expect(draft.evidence[0]).toMatchObject({
      toolCallId: "call_1",
      claim: expect.stringContaining(QS_LATEST),
    });
    expect(ledger.toolCall("call_1")?.output).toEqual(npmOutput);
    // the adapter got the researcher's tools and the envelope schema wrapping the subtask schema
    const input = adapter.inputs[0]!;
    expect(input.role).toBe("researcher");
    expect(input.tools.map((t) => t.name)).toContain("get_package_metadata");
    expect(input.tools.map((t) => t.name)).not.toContain("github_create_issue");
    expect(input.resultSchema).toMatchObject({ required: ["value", "evidence"] });

    const events: TraceEventInput[] = [];
    const critic = deps(acceptingCritic(), "critic-a", ledger);
    const outcome = await produceWithReview({
      produce: async () => draft,
      review: (d, attempt) =>
        reviewDraft(
          { ...critic, jev: fakeJev, blackboard: board, emit: (e) => events.push(e) },
          {
            subtask: st,
            draft: d,
            producer: { role: "researcher", agentId: "researcher-a" },
            attempt,
          },
        ),
      commit: (d) => commitDraft(board, st, { role: "researcher", agentId: "researcher-a" }, d),
    });
    expect(outcome.status).toBe("accepted");
    const written = board.get("qs_latest")!;
    expect(written.evidence).toHaveLength(1);
    expect(written.writtenBy).toEqual({
      role: "researcher",
      agentId: "researcher-a",
      subtaskId: "s1",
    });
    expect(events).toEqual([
      expect.objectContaining({ kind: "critic.verdict", verdict: "accepted", attempt: 1 }),
    ]);
  });

  it("marks the entry degraded when the agent reports missing data", async () => {
    const adapter = scriptedAdapter([
      () =>
        result({
          value: { package: "qs", latest: "unknown" },
          evidence: [],
          degradedReason: "npm registry returned 503",
        }),
    ]);
    const draft = await runResearcher(deps(adapter), { subtask: subtask(), inputs: {} });
    expect(draft).toMatchObject({
      status: "degraded",
      degradedReason: "npm registry returned 503",
    });
  });

  it("refuses an ok result with no evidence-linked claims", async () => {
    const adapter = scriptedAdapter([
      () => result({ value: { package: "qs", latest: "1.0.0" }, evidence: [] }),
    ]);
    await expect(runResearcher(deps(adapter), { subtask: subtask(), inputs: {} })).rejects.toThrow(
      /no evidence-linked claims/,
    );
  });

  it("throws RoleRunError when the adapter ends in error or without a result", async () => {
    const failing = scriptedAdapter([
      () => [{ type: "done", status: "error", error: "503 upstream" }],
    ]);
    await expect(
      runResearcher(deps(failing), { subtask: subtask(), inputs: {} }),
    ).rejects.toBeInstanceOf(RoleRunError);
    const silent = scriptedAdapter([() => [{ type: "done", status: "ok" }]]);
    await expect(runResearcher(deps(silent), { subtask: subtask(), inputs: {} })).rejects.toThrow(
      /no_result/,
    );
  });
});

describe("critic", () => {
  const review = async (draft: Draft, ledger: ToolLedger, board = new Blackboard()) => {
    const events: TraceEventInput[] = [];
    const verdict = await reviewDraft(
      {
        ...deps(acceptingCritic(), "critic-a", ledger),
        jev: fakeJev,
        blackboard: board,
        emit: (e) => events.push(e),
      },
      { subtask: subtask(), draft, producer: { role: "researcher", agentId: "r" }, attempt: 1 },
    );
    return { verdict, events };
  };

  it("rejects a fabricated version even when the critic model is lenient", async () => {
    const ledger = new ToolLedger();
    const adapter = scriptedAdapter([researcherScript("9.9.9")], npmExecutor);
    const draft = await runResearcher(deps(adapter, "r", ledger), {
      subtask: subtask(),
      inputs: {},
    });
    const { verdict, events } = await review(draft, ledger);
    expect(verdict.verdict).toBe("rejected");
    expect(verdict.findings[0]).toMatchObject({
      claim: "qs latest version is 9.9.9",
      severity: "blocker",
      problem: expect.stringMatching(/Jev pre-check.*0\.04/),
    });
    expect(events[0]).toMatchObject({ kind: "critic.verdict", verdict: "rejected" });
  });

  it("rejects a claim whose cited tool call does not exist", async () => {
    const ledger = new ToolLedger();
    const adapter = scriptedAdapter(
      [researcherScript(QS_LATEST, { toolCallId: "call_ghost" })],
      npmExecutor,
    );
    const draft = await runResearcher(deps(adapter, "r", ledger), {
      subtask: subtask(),
      inputs: {},
    });
    // The quote mentions the version, but the resolved evidence says the tool call never happened.
    const strictJev: Pick<Jev, "precheckClaims"> = {
      async precheckClaims(claims) {
        return Object.fromEntries(
          claims.map((c) => [c.id, c.evidence.includes("exists in the trace") ? 0.01 : 0.9]),
        );
      },
    };
    const verdict = await reviewDraft(
      {
        ...deps(acceptingCritic(), "critic-a", ledger),
        jev: strictJev,
        blackboard: new Blackboard(),
      },
      { subtask: subtask(), draft, producer: { role: "researcher", agentId: "r" }, attempt: 1 },
    );
    expect(verdict.verdict).toBe("rejected");
  });

  it("rejects an entry with no evidence-linked claims", async () => {
    const { verdict } = await review({ value: {}, evidence: [], status: "ok" }, new ToolLedger());
    expect(verdict.findings[0]).toMatchObject({
      severity: "blocker",
      problem: expect.stringMatching(/no evidence-linked claims/),
    });
  });

  it("accepts a supported claim, and honors the model's own rejection", async () => {
    const ledger = new ToolLedger();
    const adapter = scriptedAdapter([researcherScript(QS_LATEST)], npmExecutor);
    const draft = await runResearcher(deps(adapter, "r", ledger), {
      subtask: subtask(),
      inputs: {},
    });
    expect((await review(draft, ledger)).verdict.verdict).toBe("accepted");

    const strict = scriptedAdapter([
      () =>
        result({
          verdict: "rejected",
          findings: [{ claim: "qs", problem: "stale", severity: "blocker" }],
        }),
    ]);
    const verdict = await reviewDraft(
      { ...deps(strict, "critic-a", ledger), jev: fakeJev, blackboard: new Blackboard() },
      { subtask: subtask(), draft, producer: { role: "researcher", agentId: "r" }, attempt: 1 },
    );
    expect(verdict).toMatchObject({ verdict: "rejected", findings: [{ problem: "stale" }] });
  });

  it("runs the pre-check before its own review and hands the scores to the model", async () => {
    const order: string[] = [];
    const jev: Pick<Jev, "precheckClaims"> = {
      async precheckClaims(claims) {
        order.push("precheck");
        return Object.fromEntries(claims.map((c) => [c.id, 0.9]));
      },
    };
    const critic = scriptedAdapter([
      () => {
        order.push("review");
        return result({ verdict: "accepted", findings: [] });
      },
    ]);
    const ledger = new ToolLedger();
    const draft: Draft = { value: {}, evidence: [{ source: "s", claim: "c" }], status: "ok" };
    await reviewDraft(
      { ...deps(critic, "critic-a", ledger), jev, blackboard: new Blackboard() },
      { subtask: subtask(), draft, producer: { role: "researcher", agentId: "r" }, attempt: 1 },
    );
    expect(order).toEqual(["precheck", "review"]);
    expect(critic.inputs[0]!.inputs["jevPrecheck"]).toMatchObject({ scores: { claim_0: 0.9 } });
    expect(critic.inputs[0]!.tools.map((t) => t.name).sort()).toEqual([
      "get_tool_result",
      "list_blackboard",
      "read_blackboard",
    ]);
  });

  it("still reviews when Jev is unavailable and records the gap", async () => {
    const jev: Pick<Jev, "precheckClaims"> = {
      async precheckClaims() {
        throw new Error("jev 503");
      },
    };
    const draft: Draft = { value: {}, evidence: [{ source: "s", claim: "c" }], status: "ok" };
    const verdict = await reviewDraft(
      { ...deps(acceptingCritic(), "critic-a"), jev, blackboard: new Blackboard() },
      { subtask: subtask(), draft, producer: { role: "researcher", agentId: "r" }, attempt: 1 },
    );
    expect(verdict.verdict).toBe("accepted");
    expect(verdict.findings[0]).toMatchObject({
      severity: "info",
      problem: expect.stringContaining("jev 503"),
    });
  });
});

describe("rejection cap", () => {
  it("gives the producer the findings for a revision turn, then reports `rejected` at the cap", async () => {
    const board = new Blackboard({ runId: "r" });
    const ledger = new ToolLedger();
    const producer = scriptedAdapter(
      [researcherScript("9.9.9"), researcherScript("9.9.8")],
      npmExecutor,
    );
    const critic = scriptedAdapter([
      () => result({ verdict: "rejected", findings: [] }),
      () => result({ verdict: "rejected", findings: [] }),
    ]);
    const st = subtask();
    const verdicts: TraceEvent["kind"][] = [];
    const outcome = await produceWithReview({
      maxRejections: 2,
      produce: (revision) =>
        runResearcher(deps(producer, "researcher-a", ledger), {
          subtask: st,
          inputs: {},
          ...(revision ? { revision } : {}),
        }),
      review: (d, attempt) =>
        reviewDraft(
          {
            ...deps(critic, "critic-a", ledger),
            jev: fakeJev,
            blackboard: board,
            emit: (e) => verdicts.push(e.kind as TraceEvent["kind"]),
          },
          {
            subtask: st,
            draft: d,
            producer: { role: "researcher", agentId: "researcher-a" },
            attempt,
          },
        ),
      commit: (d) => commitDraft(board, st, { role: "researcher", agentId: "researcher-a" }, d),
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.rejections).toBe(2);
    expect(outcome.attempts).toBe(2);
    expect(outcome.findings.some((f) => f.severity === "blocker")).toBe(true);
    expect(verdicts).toEqual(["critic.verdict", "critic.verdict"]);
    expect(board.has("qs_latest")).toBe(false);
    // the second producer run was the revision turn
    expect(producer.inputs[0]!.task).not.toContain("REVISION REQUIRED");
    expect(producer.inputs[1]!.task).toContain("REVISION REQUIRED");
    expect(producer.inputs[1]!.task).toContain("Jev pre-check");
  });

  it("accepts after a successful revision and writes only the accepted draft", async () => {
    const board = new Blackboard({ runId: "r" });
    const ledger = new ToolLedger();
    const producer = scriptedAdapter(
      [researcherScript("9.9.9"), researcherScript(QS_LATEST)],
      npmExecutor,
    );
    const critic = scriptedAdapter([
      () => result({ verdict: "accepted", findings: [] }),
      () => result({ verdict: "accepted", findings: [] }),
    ]);
    const st = subtask();
    const outcome = await produceWithReview({
      produce: (revision) =>
        runResearcher(deps(producer, "researcher-a", ledger), {
          subtask: st,
          inputs: {},
          ...(revision ? { revision } : {}),
        }),
      review: (d, attempt) =>
        reviewDraft(
          { ...deps(critic, "critic-a", ledger), jev: fakeJev, blackboard: board },
          {
            subtask: st,
            draft: d,
            producer: { role: "researcher", agentId: "researcher-a" },
            attempt,
          },
        ),
      commit: (d) => commitDraft(board, st, { role: "researcher", agentId: "researcher-a" }, d),
    });
    expect(outcome).toMatchObject({ status: "accepted", rejections: 1, attempts: 2 });
    expect(board.getHistory("qs_latest")).toHaveLength(1);
    expect(board.get("qs_latest")!.value).toEqual({ package: "qs", latest: QS_LATEST });
  });
});

describe("executor", () => {
  const reportTask = subtask({
    id: "s4",
    roleHint: "executor",
    output: { key: "report" },
  });

  it("surfaces degraded inputs as unknown even if the model omitted them", async () => {
    const adapter = scriptedAdapter([
      () =>
        result({
          value: { summary: "ok", items: [], unknowns: [] },
          evidence: [{ source: "blackboard:vulns", claim: "no advisories were found" }],
        }),
    ]);
    const draft = await runExecutor(deps(adapter, "executor-a"), {
      subtask: reportTask,
      inputs: {
        vulns: entry({ key: "vulns", status: "degraded", value: { advisories: [] } }),
        inventory: entry({ key: "inventory" }),
      },
    });
    expect(adapter.inputs[0]!.task).toContain("DEGRADED INPUTS (report as unknown): vulns");
    expect(draft.status).toBe("degraded");
    expect((draft.value as { unknowns: string[] }).unknowns).toEqual([
      expect.stringContaining("vulns"),
    ]);
  });

  it("leaves an all-ok report alone", async () => {
    const value = { summary: "ok", items: [], unknowns: [] };
    const adapter = scriptedAdapter([
      () => result({ value, evidence: [{ source: "blackboard:inventory", claim: "c" }] }),
    ]);
    const draft = await runExecutor(deps(adapter), {
      subtask: reportTask,
      inputs: { inventory: entry({ key: "inventory" }) },
    });
    expect(draft).toMatchObject({ status: "ok", value });
    expect(adapter.inputs[0]!.tools.map((t) => t.name)).toEqual([
      "read_blackboard",
      "list_blackboard",
      "github_create_issue",
      "github_open_fix_pr",
    ]);
  });

  it("requests github_create_issue only through the approval hook", async () => {
    const trace: unknown[] = [];
    const ledger = new ToolLedger();
    const exec = createRoleToolExecutor({
      role: "executor",
      blackboard: new Blackboard(),
      ledger,
      approvalGate: new DenyAllApprovalGate("denied in test"),
      context: { traceSink: (e) => void trace.push(e) },
    });
    await expect(
      exec({
        name: "github_create_issue",
        input: { owner: "o", repo: "r", title: "t", body: "b" },
        callId: "c1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/approval denied: denied in test/);
    expect(trace.map((e) => (e as { kind: string }).kind)).toEqual([
      "tool.called",
      "approval.requested",
      "approval.denied",
      "tool.result",
    ]);
  });
});

describe("role tool sets", () => {
  it("scopes tools per role", async () => {
    expect(toolsForRole("planner")).toEqual([]);
    expect(toolsForRole("researcher").every((t) => !t.irreversible)).toBe(true);
    const board = new Blackboard();
    const signal = new AbortController().signal;
    const researcher = createRoleToolExecutor({
      role: "researcher",
      blackboard: board,
      ledger: new ToolLedger(),
    });
    await expect(
      researcher({ name: "github_create_issue", input: {}, callId: "c", signal }),
    ).rejects.toThrow(/not available to the researcher/);
    const critic = createRoleToolExecutor({
      role: "critic",
      blackboard: board,
      ledger: new ToolLedger(),
    });
    await expect(critic({ name: "osv_query", input: {}, callId: "c", signal })).rejects.toThrow(
      /not available to the critic/,
    );
  });

  it("serves blackboard and trace reads without touching the registry", async () => {
    const board = new Blackboard();
    board.write({
      key: "k",
      value: 1,
      evidence: [],
      writtenBy: { role: "researcher", agentId: "a" },
    });
    const ledger = new ToolLedger();
    ledger.record({ type: "tool_call", callId: "c1", tool: "npm", input: {} });
    ledger.record({ type: "tool_result", callId: "c1", tool: "npm", ok: true, output: "x" });
    const exec = createRoleToolExecutor({
      role: "critic",
      blackboard: board,
      ledger,
      run: () => {
        throw new Error("registry must not be called");
      },
    });
    const signal = new AbortController().signal;
    expect(
      await exec({ name: "read_blackboard", input: { key: "k" }, callId: "x", signal }),
    ).toMatchObject({ key: "k", value: 1 });
    expect(
      await exec({ name: "get_tool_result", input: { callId: "c1" }, callId: "x", signal }),
    ).toMatchObject({ output: "x" });
    expect(await exec({ name: "list_blackboard", input: {}, callId: "x", signal })).toEqual([
      expect.objectContaining({ key: "k", version: 1 }),
    ]);
  });
});
