import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Session } from "@punch/shared";

type Mode = Session["mode"];

export interface SessionMessage {
  from: "user" | "engine";
  text: string;
  at: number;
}

export interface StoredSession extends Session {
  messages: SessionMessage[];
}

export interface CreateSessionInput {
  orchestratorAgentId?: string;
  mode?: Mode;
  now?: number;
}

/**
 * File-backed orchestrator sessions (plan.md 3.4). This step owns the HTTP
 * surface and the persistence; the orchestrator agent itself lands in C2, so
 * posted messages are stored on the transcript and answered with a stub that
 * says so. Each session is one JSON file under `<sessionsDir>/<id>.json`.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(sessionsDir: string, now: () => number = () => Date.now()) {
    this.dir = sessionsDir;
    this.now = now;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async create(
    input: CreateSessionInput,
    config: { orchestratorAgentId?: string; mode: Mode },
  ): Promise<StoredSession> {
    const at = input.now ?? this.now();
    const id = `sess-${new Date(at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
    const session: StoredSession = {
      id,
      orchestratorAgentId: input.orchestratorAgentId ?? config.orchestratorAgentId ?? "unassigned",
      mode: input.mode ?? config.mode,
      createdAt: at,
      runIds: [],
      messages: [],
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(id), JSON.stringify(session, null, 2), "utf-8");
    return session;
  }

  async get(id: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(this.file(id), "utf-8");
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  async appendMessage(
    id: string,
    from: SessionMessage["from"],
    text: string,
  ): Promise<StoredSession | null> {
    const session = await this.get(id);
    if (!session) return null;
    session.messages.push({ from, text, at: this.now() });
    await fs.writeFile(this.file(id), JSON.stringify(session, null, 2), "utf-8");
    return session;
  }

  async attachRun(id: string, runId: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    if (!session.runIds.includes(runId)) session.runIds.push(runId);
    await fs.writeFile(this.file(id), JSON.stringify(session, null, 2), "utf-8");
  }
}
