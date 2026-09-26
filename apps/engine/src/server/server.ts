import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { AssignmentRequest, HealthCheckResult, SlotRole } from "@punch/shared";
import { ConfigError, getConfigPath, loadConfig, validateConfig } from "../config/loader.js";
import { TestAdapterRegistry } from "../config/registry.js";
import { authorize, extractToken, randomToken, type ServerTokens } from "./auth.js";
import { RunRegistry, BadRequestError, ConflictError, type RunRegistryOptions } from "./runs.js";
import {
  AnswerApprovalBody,
  CreateRunBody,
  CreateSessionBody,
  isValidChaosProfile,
  SendMessageBody,
  SetChaosBody,
} from "./schemas.js";
import { SessionStore } from "./sessions.js";

export interface EngineServerOptions {
  port?: number;
  host?: string;
  pairingToken?: string;
  viewerToken?: string;
  webOrigins?: string[];
  runsDir: string;
  sessionsDir?: string;
  configPath?: string;
  now?: () => number;
  transformRunOptions?: RunRegistryOptions["transformRunOptions"];
}

export interface EngineServer {
  tokens: ServerTokens;
  registry: RunRegistry;
  sessions: SessionStore;
  url: string;
  listen: (port: number, host: string) => Promise<string>;
  close: () => Promise<void>;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

/** Parse `Last-Event-ID` (the event seq) for resumable SSE; -1 means everything. */
function parseResumeId(req: http.IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  if (typeof raw !== "string") return -1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

async function readJson(
  req: http.IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { ok: false, error: "request body too large" };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (text === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "request body is not valid JSON" };
  }
}

function zodIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function createEngineServer(options: EngineServerOptions): EngineServer {
  const tokens: ServerTokens = {
    pairingToken: options.pairingToken ?? randomToken(),
    viewerToken: options.viewerToken ?? randomToken(),
  };
  const webOrigins = options.webOrigins ?? [];
  const now = options.now ?? (() => Date.now());
  const registry = new RunRegistry({
    runsDir: options.runsDir,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    now,
    ...(options.transformRunOptions ? { transformRunOptions: options.transformRunOptions } : {}),
  });
  const sessions = new SessionStore(options.sessionsDir ?? `${options.runsDir}/sessions`, now);

  let server: http.Server | null = null;

  const cors = (req: http.IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && webOrigins.includes(origin)) {
      return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    }
    return {};
  };

  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extra?: Record<string, string>,
  ): void => {
    res.writeHead(status, { ...JSON_HEADERS, ...extra });
    res.end(JSON.stringify(body));
  };

  const unauthorized = (res: http.ServerResponse, extra: Record<string, string>): void => {
    send(res, 401, { error: "unauthorized: missing or invalid bearer token" }, extra);
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent)
        send(res, 500, { error: err instanceof Error ? err.message : String(err) }, cors(req));
      else res.end();
    });
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const corsHeaders = cors(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    const segments = url.pathname
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const token = extractToken(req, url);
    const first = segments[0];

    // -- config -----------------------------------------------------------
    if (first === "config" && segments.length === 1) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      if (method === "GET") {
        try {
          const config = await loadConfig(getConfigPath(options.configPath));
          return send(res, 200, { config }, corsHeaders);
        } catch (err) {
          return send(
            res,
            500,
            { error: err instanceof Error ? err.message : String(err) },
            corsHeaders,
          );
        }
      }
      if (method === "PUT") {
        const body = await readJson(req);
        if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
        const raw = (body.value as { config?: unknown }).config;
        try {
          const config = validateConfig(raw);
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          const configPath = getConfigPath(options.configPath);
          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
          return send(res, 200, { ok: true }, corsHeaders);
        } catch (err) {
          if (err instanceof ConfigError) {
            return send(res, 400, { ok: false, issues: err.fieldErrors }, corsHeaders);
          }
          return send(
            res,
            500,
            { error: err instanceof Error ? err.message : String(err) },
            corsHeaders,
          );
        }
      }
      return send(res, 405, { error: "method not allowed" }, corsHeaders);
    }

    // -- agent / provider health checks ------------------------------------
    if (
      first === "agents" &&
      segments.length === 3 &&
      segments[2] === "test" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      try {
        const config = await loadConfig(getConfigPath(options.configPath));
        const result = await new TestAdapterRegistry().testAgent(segments[1] ?? "", config);
        const parsed = HealthCheckResult.safeParse(result);
        if (!parsed.success)
          return send(res, 500, { error: "health check returned an invalid shape" }, corsHeaders);
        if (!config.agents.some((a) => a.id === segments[1])) {
          return send(res, 404, { error: `unknown agent ${segments[1]}` }, corsHeaders);
        }
        return send(res, 200, parsed.data, corsHeaders);
      } catch (err) {
        return send(
          res,
          500,
          { error: err instanceof Error ? err.message : String(err) },
          corsHeaders,
        );
      }
    }
    if (
      first === "providers" &&
      segments.length === 3 &&
      segments[2] === "check" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      try {
        const config = await loadConfig(getConfigPath(options.configPath));
        const result = await new TestAdapterRegistry().testCliProvider(segments[1] ?? "", config);
        const parsed = HealthCheckResult.safeParse(result);
        if (!parsed.success)
          return send(res, 500, { error: "health check returned an invalid shape" }, corsHeaders);
        if (!config.providers.some((p) => p.id === segments[1])) {
          return send(res, 404, { error: `unknown provider ${segments[1]}` }, corsHeaders);
        }
        return send(res, 200, parsed.data, corsHeaders);
      } catch (err) {
        return send(
          res,
          500,
          { error: err instanceof Error ? err.message : String(err) },
          corsHeaders,
        );
      }
    }

    // -- sessions (persistence stub for C2) ---------------------------------
    if (first === "sessions" && segments.length === 1 && method === "POST") {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const body = await readJson(req);
      if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
      const parsed = CreateSessionBody.safeParse(body.value);
      if (!parsed.success)
        return send(
          res,
          400,
          { error: "invalid session request", issues: zodIssues(parsed.error) },
          corsHeaders,
        );
      let defaults: { orchestratorAgentId?: string; mode: "auto" | "manual" } = {
        mode: parsed.data.mode ?? "auto",
      };
      try {
        const config = await loadConfig(getConfigPath(options.configPath));
        defaults = {
          ...(config.defaults.orchestratorAgentId
            ? { orchestratorAgentId: config.defaults.orchestratorAgentId }
            : {}),
          mode: parsed.data.mode ?? config.defaults.mode,
        };
      } catch {
        // No readable config: fall back to the request values.
      }
      const stored = await sessions.create(
        {
          ...(parsed.data.orchestratorAgentId
            ? { orchestratorAgentId: parsed.data.orchestratorAgentId }
            : {}),
          ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
        },
        defaults,
      );
      const { messages: _messages, ...session } = stored;
      void _messages;
      return send(res, 201, session, corsHeaders);
    }
    if (first === "sessions" && segments.length === 2 && method === "GET") {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const stored = await sessions.get(segments[1] ?? "");
      if (!stored) return send(res, 404, { error: `unknown session ${segments[1]}` }, corsHeaders);
      const { messages: _messages, ...session } = stored;
      void _messages;
      return send(res, 200, session, corsHeaders);
    }
    if (
      first === "sessions" &&
      segments.length === 3 &&
      segments[2] === "messages" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const body = await readJson(req);
      if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
      const parsed = SendMessageBody.safeParse(body.value);
      if (!parsed.success)
        return send(
          res,
          400,
          { error: "invalid message", issues: zodIssues(parsed.error) },
          corsHeaders,
        );
      const stored = await sessions.appendMessage(segments[1] ?? "", "user", parsed.data.text);
      if (!stored) return send(res, 404, { error: `unknown session ${segments[1]}` }, corsHeaders);
      return send(
        res,
        200,
        {
          reply: "Orchestrator sessions arrive in C2; your message is recorded on the transcript.",
        },
        corsHeaders,
      );
    }
    if (
      first === "sessions" &&
      segments.length === 3 &&
      segments[2] === "events" &&
      method === "GET"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const stored = await sessions.get(segments[1] ?? "");
      if (!stored) return send(res, 404, { error: `unknown session ${segments[1]}` }, corsHeaders);
      res.writeHead(200, { ...sseHeaders(), ...corsHeaders });
      let sent = 0;
      const push = async (): Promise<boolean> => {
        const current = await sessions.get(segments[1] ?? "");
        if (!current) return false;
        while (sent < current.messages.length) {
          const message = current.messages[sent];
          sent += 1;
          res.write(`id: ${sent}\ndata: ${JSON.stringify(message)}\n\n`);
        }
        return true;
      };
      await push();
      const timer = setInterval(() => {
        void push().then((ok) => {
          if (!ok) {
            clearInterval(timer);
            res.end();
          }
        });
        res.write(": ping\n\n");
      }, 15_000);
      req.on("close", () => clearInterval(timer));
      return;
    }

    // -- runs ---------------------------------------------------------------
    if (first === "runs" && segments.length === 1) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      if (method === "GET") return send(res, 200, { runs: registry.list() }, corsHeaders);
      if (method === "POST") {
        const body = await readJson(req);
        if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
        const parsed = CreateRunBody.safeParse(body.value);
        if (!parsed.success) {
          return send(
            res,
            400,
            { error: "invalid run request", issues: zodIssues(parsed.error) },
            corsHeaders,
          );
        }
        const invalidChaos = parsed.data.chaos.filter((profile) => !isValidChaosProfile(profile));
        if (invalidChaos.length > 0) {
          return send(
            res,
            400,
            { error: `invalid chaos profiles: ${invalidChaos.join(", ")}` },
            corsHeaders,
          );
        }
        try {
          const { id } = await registry.start(parsed.data);
          return send(res, 201, { id, status: "running" }, corsHeaders);
        } catch (err) {
          if (err instanceof BadRequestError)
            return send(res, 400, { error: err.message }, corsHeaders);
          if (err instanceof ConflictError)
            return send(res, 409, { error: err.message }, corsHeaders);
          return send(
            res,
            500,
            { error: err instanceof Error ? err.message : String(err) },
            corsHeaders,
          );
        }
      }
      return send(res, 405, { error: "method not allowed" }, corsHeaders);
    }

    if (first === "runs" && segments.length === 2 && method === "GET") {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const detail = registry.detail(segments[1] ?? "");
      if (!detail) return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      return send(res, 200, detail, corsHeaders);
    }

    if (first === "runs" && segments.length === 3 && segments[2] === "trace" && method === "GET") {
      if (!authorize(token, tokens, "viewer")) return unauthorized(res, corsHeaders);
      const jsonl = await registry.traceJsonl(segments[1] ?? "");
      if (jsonl === null)
        return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", ...corsHeaders });
      res.end(jsonl);
      return;
    }

    if (first === "runs" && segments.length === 3 && segments[2] === "events" && method === "GET") {
      if (!authorize(token, tokens, "viewer")) return unauthorized(res, corsHeaders);
      const id = segments[1] ?? "";
      if (!registry.get(id)) {
        // Finished runs served from disk still stream, then DONE.
        const jsonl = await registry.traceJsonl(id);
        if (jsonl === null) return send(res, 404, { error: `unknown run ${id}` }, corsHeaders);
        res.writeHead(200, { ...sseHeaders(), ...corsHeaders });
        for (const line of jsonl.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) res.write(`data: ${trimmed}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const resume = parseResumeId(req);
      res.writeHead(200, { ...sseHeaders(), ...corsHeaders });
      let lastSent = resume;
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        registry.unsubscribe(id, pump);
        res.write("data: [DONE]\n\n");
        res.end();
      };
      const pump = (): void => {
        if (closed) return;
        const events = registry.events(id) ?? [];
        for (const event of events) {
          if (event.seq > lastSent) {
            lastSent = event.seq;
            res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        }
        if (registry.isSettled(id)) finish();
      };
      const heartbeat = setInterval(() => {
        if (!closed) res.write(": ping\n\n");
      }, 15_000);
      registry.subscribe(id, pump);
      pump();
      req.on("close", () => {
        if (!closed) {
          closed = true;
          clearInterval(heartbeat);
          registry.unsubscribe(id, pump);
        }
      });
      return;
    }

    if (
      first === "runs" &&
      segments.length === 3 &&
      segments[2] === "assignments" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const body = await readJson(req);
      if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
      const parsed = AssignmentRequest.safeParse(body.value);
      if (!parsed.success) {
        return send(
          res,
          400,
          { error: "invalid assignments", issues: zodIssues(parsed.error) },
          corsHeaders,
        );
      }
      if (!registry.setAssignments(segments[1] ?? "", parsed.data)) {
        return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      }
      return send(res, 200, { ok: true }, corsHeaders);
    }

    if (
      first === "runs" &&
      segments.length === 4 &&
      segments[2] === "approvals" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const body = await readJson(req);
      if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
      const parsed = AnswerApprovalBody.safeParse(body.value);
      if (!parsed.success) {
        return send(
          res,
          400,
          { error: "invalid approval answer", issues: zodIssues(parsed.error) },
          corsHeaders,
        );
      }
      const outcome = registry.answerApproval(segments[1] ?? "", segments[3] ?? "", {
        approved: parsed.data.decision === "approve",
        decidedBy: "http",
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      });
      if (outcome === "unknown-run")
        return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      if (outcome === "unknown-approval") {
        return send(
          res,
          404,
          { error: `unknown or already answered approval ${segments[3]}` },
          corsHeaders,
        );
      }
      return send(res, 200, { ok: true }, corsHeaders);
    }

    if (
      first === "runs" &&
      segments.length === 5 &&
      segments[2] === "slots" &&
      segments[4] === "kill" &&
      method === "POST"
    ) {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const role = SlotRole.safeParse(segments[3]);
      if (!role.success) {
        return send(res, 400, { error: `unknown slot "${segments[3]}"` }, corsHeaders);
      }
      const outcome = registry.kill(segments[1] ?? "", role.data);
      if (outcome === null)
        return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      return send(res, 200, { ok: true, killed: outcome.killed }, corsHeaders);
    }

    if (first === "runs" && segments.length === 3 && segments[2] === "chaos" && method === "POST") {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      const body = await readJson(req);
      if (!body.ok) return send(res, 400, { error: body.error }, corsHeaders);
      const parsed = SetChaosBody.safeParse(body.value);
      if (!parsed.success) {
        return send(
          res,
          400,
          { error: "invalid chaos request", issues: zodIssues(parsed.error) },
          corsHeaders,
        );
      }
      const invalid = parsed.data.profiles.filter((profile) => !isValidChaosProfile(profile));
      if (invalid.length > 0) {
        return send(
          res,
          400,
          { error: `invalid chaos profiles: ${invalid.join(", ")}` },
          corsHeaders,
        );
      }
      const outcome = registry.setChaos(segments[1] ?? "", parsed.data.profiles);
      if (outcome === "staged") return send(res, 200, { ok: true, pending: true }, corsHeaders);
      return send(
        res,
        409,
        { error: `run ${segments[1]} already started; chaos applies at run start` },
        corsHeaders,
      );
    }

    if (first === "runs" && segments.length === 3 && segments[2] === "stop" && method === "POST") {
      if (!authorize(token, tokens, "control")) return unauthorized(res, corsHeaders);
      if (!registry.get(segments[1] ?? "")) {
        return send(res, 404, { error: `unknown run ${segments[1]}` }, corsHeaders);
      }
      if (!registry.stop(segments[1] ?? "")) {
        return send(res, 409, { error: `run ${segments[1]} already finished` }, corsHeaders);
      }
      return send(res, 200, { ok: true }, corsHeaders);
    }

    return send(res, 404, { error: `unknown route ${method} ${url.pathname}` }, corsHeaders);
  }

  const listen = (port: number, host: string): Promise<string> =>
    new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server?.address() as AddressInfo | null;
        const actualPort = address?.port ?? port;
        resolve(`http://${host}:${actualPort}`);
      });
    });

  return {
    tokens,
    registry,
    sessions,
    get url() {
      const address = server?.address();
      if (address && typeof address === "object")
        return `http://${address.address}:${address.port}`;
      return "";
    },
    listen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export type { ServerTokens };
