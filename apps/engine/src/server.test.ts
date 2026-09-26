import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AdapterRegistry } from "@punch/core";
import type { AdapterFactoryContext, RunLoopOptions } from "@punch/core";
import type { AdapterRunInput, AgentAdapter, AgentEvent, TraceEvent } from "@punch/shared";
import { buildProgram } from "./cli.js";
import { createEngineServer, type EngineServer } from "./server/server.js";
import { serveCommand } from "./server/serve.js";

const CLEAN_FIXTURE_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../fixtures/runs/clean",
);

const tempDirs: string[] = [];
async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Every adapter event delayed, so kills and approvals land mid-run deterministically. */
function slowRegistry(inner: AdapterRegistry, ms: number): AdapterRegistry {
  const out = new AdapterRegistry();
  for (const kind of inner.kinds()) {
    out.register(kind, (ctx: AdapterFactoryContext): AgentAdapter => {
      const adapter = inner.create(ctx);
      return {
        capabilities: adapter.capabilities,
        test: () => adapter.test(),
        run: (input: AdapterRunInput): AsyncIterable<AgentEvent> =>
          slowStream(adapter.run(input), ms),
      };
    });
  }
  return out;
}

async function* slowStream(
  events: AsyncIterable<AgentEvent>,
  ms: number,
): AsyncGenerator<AgentEvent> {
  for await (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    yield event;
  }
}

interface TestServer {
  server: EngineServer;
  url: string;
  pairing: string;
  viewer: string;
}

async function startTestServer(opts?: {
  slowMs?: number;
  webOrigins?: string[];
  configPath?: string;
}): Promise<TestServer> {
  const runsDir = await mkTemp("punch-http-runs-");
  const sessionsDir = await mkTemp("punch-http-sess-");
  const slowMs = opts?.slowMs;
  const server = createEngineServer({
    runsDir,
    sessionsDir,
    pairingToken: "pair-test",
    viewerToken: "view-test",
    ...(opts?.webOrigins ? { webOrigins: opts.webOrigins } : {}),
    ...(opts?.configPath ? { configPath: opts.configPath } : {}),
    ...(slowMs !== undefined
      ? {
          transformRunOptions: (loopOptions: RunLoopOptions): RunLoopOptions => ({
            ...loopOptions,
            adapters: slowRegistry(loopOptions.adapters, slowMs),
          }),
        }
      : {}),
  });
  const url = await server.listen(0, "127.0.0.1");
  return { server, url, pairing: "pair-test", viewer: "view-test" };
}

interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function api(
  method: string,
  url: string,
  opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

interface SseFrame {
  id?: string;
  data: string;
}

/** Read SSE frames until [DONE], the stream ends, or the signal aborts. */
async function readSse(
  url: string,
  opts?: { token?: string; lastEventId?: number; signal?: AbortSignal },
): Promise<{ status: number; frames: SseFrame[] }> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts?.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
  const res = await fetch(url, { headers, signal: opts?.signal });
  if (!res.ok || !res.body) return { status: res.status, frames: [] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let current: SseFrame = { data: "" };
  let hasData = false;
  const frames: SseFrame[] = [];
  let done = false;
  const dispatch = (): void => {
    if (!hasData) {
      current = { data: "" };
      return;
    }
    if (current.data === "[DONE]") done = true;
    else frames.push(current);
    current = { data: "" };
    hasData = false;
  };
  while (!done) {
    const { done: streamDone, value } = await reader
      .read()
      .catch(() => ({ done: true as const, value: undefined }));
    if (streamDone) break;
    if (!value) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "") {
        dispatch();
        if (done) break;
      } else if (line.startsWith("data:")) {
        current.data = line.slice(5).trim();
        hasData = true;
      } else if (line.startsWith("id:")) {
        current.id = line.slice(3).trim();
      }
    }
  }
  await reader.cancel().catch(() => {});
  return { status: res.status, frames };
}

function parseTraceJsonl(text: string): TraceEvent[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The clean fixture plus one irreversible executor call, so the run pauses
 * on `approval.requested` and the test can deny it over HTTP.
 */
async function makeApprovalFixture(): Promise<string> {
  const dir = await mkTemp("punch-http-fixture-");
  const fixtureDir = path.join(dir, "fixture");
  await fs.mkdir(fixtureDir, { recursive: true });
  const raw = JSON.parse(await fs.readFile(path.join(CLEAN_FIXTURE_DIR, "run.json"), "utf-8")) as {
    http: { file?: string }[];
    agents: { executor: { s4: { calls: unknown[] } } };
  };
  for (const rule of raw.http) {
    if (rule.file) rule.file = path.resolve(CLEAN_FIXTURE_DIR, rule.file);
  }
  raw.agents.executor.s4.calls.push({
    tool: "github_create_issue",
    input: {
      owner: "Mani212005",
      repo: "punch",
      title: "Fixture approval probe",
      body: "Deny me.",
    },
  });
  await fs.writeFile(path.join(fixtureDir, "run.json"), JSON.stringify(raw), "utf-8");
  return fixtureDir;
}

describe("engine HTTP API: full fixture run over HTTP only", () => {
  it(
    "drives a run with one kill-takeover and one denied approval",
    { timeout: 90_000 },
    async () => {
      const fixture = await makeApprovalFixture();
      const { server, url, pairing, viewer } = await startTestServer({ slowMs: 20 });
      try {
        // Start the run over HTTP only.
        const created = await api("POST", `${url}/runs`, {
          token: pairing,
          body: { fixture },
        });
        expect(created.status).toBe(201);
        const runId = (created.json as { id: string }).id;
        expect(typeof runId).toBe("string");

        // Kill the researcher mid-subtask until the supervisor reports it.
        await waitFor(
          async () => {
            const killed = await api("POST", `${url}/runs/${runId}/slots/researcher/kill`, {
              token: pairing,
            });
            return killed.status === 200 && (killed.json as { killed: boolean }).killed === true;
          },
          20_000,
          "researcher kill to land",
        );

        // Deny the irreversible action over HTTP.
        let approvalId = "";
        await waitFor(
          async () => {
            const trace = await api("GET", `${url}/runs/${runId}/trace`, { token: pairing });
            for (const event of parseTraceJsonl(trace.text)) {
              if (event.kind === "approval.requested") {
                approvalId = event.approvalId;
                return true;
              }
            }
            return false;
          },
          30_000,
          "approval.requested",
        );
        const denied = await api("POST", `${url}/runs/${runId}/approvals/${approvalId}`, {
          token: pairing,
          body: { decision: "deny", reason: "http test denies" },
        });
        expect(denied.status).toBe(200);

        // The run settles (degraded: the report lost its issue-filing input).
        await waitFor(
          async () => {
            const detail = await api("GET", `${url}/runs/${runId}`, { token: pairing });
            return ["completed", "degraded", "aborted", "failed"].includes(
              (detail.json as { summary: { status: string } }).summary.status,
            );
          },
          30_000,
          "run to settle",
        );

        const trace = await api("GET", `${url}/runs/${runId}/trace`, { token: pairing });
        expect(trace.status).toBe(200);
        const events = parseTraceJsonl(trace.text);
        const kinds = events.map((event) => event.kind);
        expect(kinds).toContain("slot.failed");
        expect(kinds).toContain("slot.replacing");
        expect(kinds).toContain("slot.replaced");
        expect(kinds).toContain("approval.requested");
        expect(kinds).toContain("approval.denied");
        expect(kinds).toContain("run.finished");
        const kill = events.find(
          (event) => event.kind === "slot.failed" && event.role === "researcher",
        );
        expect(kill).toMatchObject({ reason: { kind: "operator_kill" } });

        // The viewer token reads events and trace but controls nothing.
        const viewerTrace = await api("GET", `${url}/runs/${runId}/trace`, { token: viewer });
        expect(viewerTrace.status).toBe(200);
        const viewerEvents = await readSse(`${url}/runs/${runId}/events`, { token: viewer });
        expect(viewerEvents.status).toBe(200);
        expect(viewerEvents.frames.length).toBe(events.length);
        expect(
          await api("POST", `${url}/runs/${runId}/slots/researcher/kill`, { token: viewer }).then(
            (r) => r.status,
          ),
        ).toBe(401);
        expect(
          await api("POST", `${url}/runs/${runId}/approvals/x`, {
            token: viewer,
            body: { decision: "deny" },
          }).then((r) => r.status),
        ).toBe(401);
        expect(
          await api("POST", `${url}/runs/${runId}/stop`, { token: viewer }).then((r) => r.status),
        ).toBe(401);
        expect(await api("GET", `${url}/runs`, {}).then((r) => r.status)).toBe(401);

        // SSE resumes by Last-Event-ID (the event seq): nothing repeats.
        const resumed = await readSse(`${url}/runs/${runId}/events`, {
          token: pairing,
          lastEventId: 2,
        });
        expect(resumed.status).toBe(200);
        expect(resumed.frames.length).toBe(events.length - 3);
        expect(JSON.parse(resumed.frames[0]?.data ?? "") as TraceEvent).toMatchObject({ seq: 3 });
      } finally {
        await server.close();
      }
    },
  );
});

describe("engine HTTP API: routes, auth, and validation", () => {
  it(
    "serves config, sessions, chaos, assignments, and rejects bad input",
    { timeout: 60_000 },
    async () => {
      const previousKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key";
      const configDir = await mkTemp("punch-http-config-");
      const configPath = path.join(configDir, "config.json");
      await fs.writeFile(
        configPath,
        await fs
          .readFile(path.join(CLEAN_FIXTURE_DIR, "run.json"), "utf-8")
          .then((text) => JSON.stringify((JSON.parse(text) as { config: unknown }).config)),
        "utf-8",
      );
      const { server, url, pairing } = await startTestServer({ configPath });
      try {
        // Config round-trip.
        const got = await api("GET", `${url}/config`, { token: pairing });
        expect(got.status).toBe(200);
        expect(got.json).toMatchObject({ config: { version: 1 } });
        const badPut = await api("PUT", `${url}/config`, {
          token: pairing,
          body: { config: { version: 1 } },
        });
        expect(badPut.status).toBe(400);
        expect(badPut.json).toMatchObject({ ok: false });
        const current = (got.json as { config: Record<string, unknown> }).config;
        const goodPut = await api("PUT", `${url}/config`, {
          token: pairing,
          body: {
            config: { ...current, budgets: { maxSteps: 61, maxUsd: 5, maxWallClockMs: 120000 } },
          },
        });
        expect(goodPut.json).toMatchObject({ ok: true });

        // Health checks.
        expect(
          await api("POST", `${url}/agents/opus/test`, { token: pairing }).then((r) => r.status),
        ).toBe(200);
        expect(
          await api("POST", `${url}/agents/nope/test`, { token: pairing }).then((r) => r.status),
        ).toBe(404);
        expect(
          await api("POST", `${url}/providers/nope/check`, { token: pairing }).then(
            (r) => r.status,
          ),
        ).toBe(404);

        // Sessions persist across reads.
        const created = await api("POST", `${url}/sessions`, { token: pairing, body: {} });
        expect(created.status).toBe(201);
        const sessionId = (created.json as { id: string }).id;
        const fetched = await api("GET", `${url}/sessions/${sessionId}`, { token: pairing });
        expect(fetched.json).toMatchObject({ id: sessionId, runIds: [] });
        const messaged = await api("POST", `${url}/sessions/${sessionId}/messages`, {
          token: pairing,
          body: { text: "hello orchestrator" },
        });
        expect(messaged.status).toBe(200);
        expect(
          await api("GET", `${url}/sessions/nope`, { token: pairing }).then((r) => r.status),
        ).toBe(404);

        // Chaos: invalid profiles rejected; staged chaos applies at run start.
        const badChaos = await api("POST", `${url}/runs/some-run/chaos`, {
          token: pairing,
          body: { profiles: ["explode:everything"] },
        });
        expect(badChaos.status).toBe(400);
        const stagedChaos = await api("POST", `${url}/runs/staged-run-1/chaos`, {
          token: pairing,
          body: { profiles: ["tool:osv_query:500"] },
        });
        expect(stagedChaos.json).toMatchObject({ ok: true, pending: true });
        const fixture = await makeApprovalFixture();
        const started = await api("POST", `${url}/runs`, {
          token: pairing,
          body: { fixture, runId: "staged-run-1" },
        });
        expect(started.status).toBe(201);
        const detail = await api("GET", `${url}/runs/staged-run-1`, { token: pairing });
        expect(detail.json).toMatchObject({ chaos: ["tool:osv_query:500"] });
        expect(
          await api("POST", `${url}/runs/staged-run-1/chaos`, {
            token: pairing,
            body: { profiles: ["tool:osv_query:500"] },
          }).then((r) => r.status),
        ).toBe(409);

        // Assignments, kill, approvals, and stop validate their inputs.
        const assigned = await api("POST", `${url}/runs/staged-run-1/assignments`, {
          token: pairing,
          body: { selections: [], confirmed: true },
        });
        expect(assigned.json).toMatchObject({ ok: true });
        expect(
          await api("POST", `${url}/runs/staged-run-1/assignments`, {
            token: pairing,
            body: { selections: "nope" },
          }).then((r) => r.status),
        ).toBe(400);
        expect(
          await api("POST", `${url}/runs/staged-run-1/slots/bogus/kill`, { token: pairing }).then(
            (r) => r.status,
          ),
        ).toBe(400);
        expect(
          await api("POST", `${url}/runs/nope/slots/researcher/kill`, { token: pairing }).then(
            (r) => r.status,
          ),
        ).toBe(404);
        expect(
          await api("POST", `${url}/runs/nope`, { token: pairing }).then((r) => r.status),
        ).toBe(404);
        expect(
          await api("POST", `${url}/runs/nope/stop`, { token: pairing }).then((r) => r.status),
        ).toBe(404);
        expect(
          await api("POST", `${url}/runs`, { token: pairing, body: {} }).then((r) => r.status),
        ).toBe(400);
        expect(
          await api("POST", `${url}/runs/staged-run-1/approvals/nope`, {
            token: pairing,
            body: { decision: "approve" },
          }).then((r) => r.status),
        ).toBe(404);

        // Stop settles the run so no background work outlives the test.
        await api("POST", `${url}/runs/staged-run-1/stop`, { token: pairing });
        await waitFor(
          async () => {
            const detail = await api("GET", `${url}/runs/staged-run-1`, { token: pairing });
            return ["completed", "degraded", "aborted", "failed"].includes(
              (detail.json as { summary: { status: string } }).summary.status,
            );
          },
          30_000,
          "staged run to settle",
        );
        expect(
          await api("POST", `${url}/runs/staged-run-1/stop`, { token: pairing }).then(
            (r) => r.status,
          ),
        ).toBe(409);
      } finally {
        if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousKey;
        await server.close();
      }
    },
  );

  it("limits CORS to the configured web origins", { timeout: 30_000 }, async () => {
    const { server, url, pairing } = await startTestServer({
      webOrigins: ["http://localhost:3000"],
    });
    try {
      const allowed = await api("GET", `${url}/runs`, {
        token: pairing,
        headers: { Origin: "http://localhost:3000" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      const denied = await api("GET", `${url}/runs`, {
        token: pairing,
        headers: { Origin: "https://evil.example" },
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await api("OPTIONS", `${url}/runs`, {
        headers: { Origin: "http://localhost:3000" },
      });
      expect(preflight.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("wires punch serve with tokens, ports, and origins", { timeout: 30_000 }, async () => {
    const lines: string[] = [];
    const running = await serveCommand({
      port: 0,
      host: "127.0.0.1",
      runsDir: await mkTemp("punch-serve-runs-"),
      log: (line: string) => lines.push(line),
    });
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(running.pairingToken.length).toBeGreaterThan(16);
      expect(running.viewerToken.length).toBeGreaterThan(16);
      expect(lines.some((line) => line.includes("pairing token:"))).toBe(true);
      const res = await fetch(`${running.url}/runs`, {
        headers: { Authorization: `Bearer ${running.pairingToken}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }

    const serve = buildProgram().commands.find((command) => command.name() === "serve");
    expect(serve).toBeDefined();
    expect(serve?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--port",
        "--host",
        "--pairing-token",
        "--viewer-token",
        "--web-origin",
        "--runs-dir",
      ]),
    );
  });
});
