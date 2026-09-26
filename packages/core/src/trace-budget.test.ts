import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRACE_EVENT_KINDS, type TraceEventKind } from "@punch/shared";
import { BudgetMeter } from "./budget.js";
import { TraceWriter, readTrace } from "./trace/writer.js";

const entry = {
  key: "vulns",
  version: 1,
  status: "ok" as const,
  value: { count: 2 },
  evidence: [{ source: "osv", url: "https://api.osv.dev/v1/query" }],
  writtenBy: { role: "researcher", agentId: "a1", subtaskId: "s1" },
  ts: 1_700_000_000_000,
};

const finding = {
  claim: "lodash 4.17.99 exists",
  problem: "no such version",
  severity: "blocker" as const,
};

const budget = { stepsRemaining: 10, usdRemaining: 1.5, msRemaining: 60_000 };
const who = { role: "researcher" as const, agentId: "a1", subtaskId: "s1" };
const subtask = {
  id: "s1",
  title: "Inventory",
  description: "List deps",
  dependsOn: [],
  roleHint: "researcher" as const,
  output: { key: "deps" },
  inputKeys: [],
  status: "pending" as const,
};

const payloads: { [K in TraceEventKind]: Record<string, unknown> } = {
  "run.started": {
    task: { repoUrl: "https://github.com/a/b" },
    mode: "auto",
    budgets: { maxSteps: 100, maxUsd: 5, maxWallClockMs: 600_000 },
    chaos: ["stall:researcher"],
  },
  "route.decided": {
    role: "researcher",
    agentId: "a1",
    provenance: "jev",
    probabilities: [{ agentId: "a1", probability: 0.7 }],
    confidence: 0.7,
    difficulty: "moderate",
  },
  "route.skipped": { role: "critic", reason: "pinned" },
  "plan.created": { subtasks: [subtask] },
  "slot.assigned": {
    role: "researcher",
    agentId: "a1",
    provenance: "pin",
    standby: [{ agentId: "a2", probability: 0.2 }],
  },
  "agent.started": { ...who, attempt: 1, effort: "medium" },
  "agent.heartbeat": who,
  "agent.text": { ...who, text: "hello" },
  "agent.opaque_output": { ...who, text: "cli output" },
  "tool.called": { ...who, callId: "c1", tool: "osv_query", input: { name: "lodash" } },
  "tool.result": {
    callId: "c1",
    tool: "osv_query",
    ok: true,
    cached: true,
    latencyMs: 0,
    retries: 0,
    output: { vulns: [] },
  },
  "tool.retry": {
    callId: "c1",
    tool: "osv_query",
    attempt: 1,
    delayMs: 250,
    errorClass: "transient",
    error: "503",
  },
  "fallback.used": { tool: "osv", from: "osv", to: "gh-advisory", reason: "permanent" },
  "blackboard.written": { key: "vulns", entry },
  "slot.stalled": { ...who, silentMs: 46_000, nudged: true },
  "slot.failed": {
    ...who,
    reason: { kind: "operator_kill", detail: "killed by operator" },
    classification: "permanent",
  },
  "slot.rejected": { ...who, rejections: 2, findings: [finding] },
  "slot.replacing": {
    role: "researcher",
    subtaskId: "s1",
    failedAgentId: "a1",
    replacementAgentId: "a2",
    reason: { kind: "failed", detail: "503" },
    handoff: {
      inputKeys: ["deps"],
      cachedResultCount: 3,
      partialNotes: "half done",
      criticFindings: null,
      budget,
    },
    selection: {
      provenance: "standby",
      rank: 1,
      probability: 0.2,
      skipped: [{ agentId: "a3", reason: "same provider failed" }],
    },
    detectionMs: 1200,
  },
  "slot.replaced": {
    role: "researcher",
    subtaskId: "s1",
    failedAgentId: "a1",
    replacementAgentId: "a2",
    takeoverMs: 1800,
  },
  "slot.exhausted": {
    role: "researcher",
    subtaskId: "s1",
    reason: "no replacement",
    degradedKey: "deps",
  },
  "critic.verdict": {
    subtaskId: "s1",
    agentId: "a4",
    verdict: "rejected",
    attempt: 1,
    findings: [finding],
  },
  "approval.requested": {
    approvalId: "ap1",
    tool: "github_create_issue",
    payload: { title: "x" },
  },
  "approval.granted": { approvalId: "ap1", decidedBy: "cli" },
  "approval.denied": { approvalId: "ap1", decidedBy: "console", reason: "nope" },
  "budget.checked": {
    steps: { used: 3, max: 100 },
    usd: { used: 0.1, max: 5 },
    ms: { used: 1000, max: 600_000 },
    exceeded: null,
  },
  "replan.triggered": { subtaskId: "s2", reason: "permanent failure with dependents" },
  "compensation.ran": { action: "close_issue", ok: true },
  "run.finished": { status: "degraded", summary: "one subtask degraded", reportKey: "report" },
};

describe("Trace and Budget integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "punch-integration-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("every single event kind round-trips through TraceWriter and TraceReader", async () => {
    const traceFile = path.join(tmpDir, "full-trace.jsonl");
    const writer = new TraceWriter({
      runId: "full-run",
      filePath: traceFile,
      now: () => 1_700_000_000_000,
    });

    const writtenEvents = [];
    for (const kind of TRACE_EVENT_KINDS) {
      const event = await writer.write({
        kind,
        ...payloads[kind as TraceEventKind],
      });
      writtenEvents.push(event);
    }

    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(TRACE_EVENT_KINDS.length);

    for (let i = 0; i < TRACE_EVENT_KINDS.length; i++) {
      expect(readEvents[i]).toEqual(writtenEvents[i]);
      expect(readEvents[i]?.seq).toBe(i);
      expect(readEvents[i]?.kind).toBe(TRACE_EVENT_KINDS[i]);
    }
  });

  it("fires each limit with a fake clock and writes budget.checked trace events", async () => {
    const traceFile = path.join(tmpDir, "budget-trace.jsonl");
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;

    const writer = new TraceWriter({
      runId: "budget-run",
      filePath: traceFile,
      now,
    });

    const meter = new BudgetMeter({
      budgets: { maxSteps: 4, maxUsd: 1.0, maxWallClockMs: 10_000 },
      pricingMap: {
        agent1: { inputUsdPerMTok: 2.0, outputUsdPerMTok: 10.0 },
      },
      now,
    });

    // Step 1
    meter.recordStep(1);
    await writer.write(meter.createBudgetCheckedEvent({ runId: "budget-run" }));

    // Advance time and check wallClock cap
    currentTime += 12_000;
    const wallClockStatus = meter.check();
    expect(wallClockStatus.exceeded).toBe("wallClock");
    expect(meter.signal.aborted).toBe(true);

    await writer.write(meter.createBudgetCheckedEvent({ runId: "budget-run" }));
    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(2);

    expect(readEvents[0]?.kind).toBe("budget.checked");
    if (readEvents[0]?.kind === "budget.checked") {
      expect(readEvents[0].steps.used).toBe(1);
      expect(readEvents[0].exceeded).toBeNull();
    }

    expect(readEvents[1]?.kind).toBe("budget.checked");
    if (readEvents[1]?.kind === "budget.checked") {
      expect(readEvents[1].exceeded).toBe("wallClock");
      expect(readEvents[1].ms.used).toBe(12_000);
    }
  });

  it("redacts credentials inside tool calls and blackboard writes", async () => {
    const traceFile = path.join(tmpDir, "redacted-trace.jsonl");
    const writer = new TraceWriter({
      runId: "redact-run",
      filePath: traceFile,
      additionalSecrets: ["ghp_mySuperSecretGitHubPersonalAccessToken999"],
      env: {
        MY_API_KEY: "sk-ant-api03-private-secret-1234567890",
      },
      apiKeyEnvs: ["MY_API_KEY"],
    });

    await writer.write({
      kind: "tool.called",
      role: "executor",
      agentId: "a1",
      subtaskId: "s1",
      callId: "c1",
      tool: "github_create_issue",
      input: {
        repo: "user/repo",
        headers: {
          Authorization: "Bearer ghp_mySuperSecretGitHubPersonalAccessToken999",
        },
        apiKey: "sk-ant-api03-private-secret-1234567890",
      },
    });

    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(1);
    const event = readEvents[0];
    if (event?.kind === "tool.called") {
      const input = event.input as Record<string, unknown>;
      expect(input.apiKey).toBe("[REDACTED]");
      const headers = input.headers as Record<string, unknown>;
      expect(headers.Authorization).toBe("[REDACTED]");
    } else {
      expect.fail("Expected tool.called event");
    }
  });
});
