import type { Config, SlotRole } from "@punch/shared";

/** Engine URL and pairing token, kept in the browser (plan.md 4.3). */
export interface Pairing {
  engineUrl: string;
  token: string;
}

export const PAIRING_STORAGE_KEY = "punch.pairing";
export const DEFAULT_ENGINE_URL =
  process.env.NEXT_PUBLIC_DEFAULT_ENGINE_URL ?? "http://localhost:4141";

export function normalizeEngineUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function loadPairing(): Pairing | null {
  try {
    const raw = window.localStorage.getItem(PAIRING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Pairing>;
    if (typeof parsed.engineUrl === "string" && typeof parsed.token === "string") {
      return { engineUrl: parsed.engineUrl, token: parsed.token };
    }
  } catch {
    // Storage can be blocked or hold junk; treat as unpaired.
  }
  return null;
}

export function savePairing(pairing: Pairing): void {
  try {
    window.localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(pairing));
  } catch {
    // The pairing then lasts only for this page load.
  }
}

export function clearPairing(): void {
  try {
    window.localStorage.removeItem(PAIRING_STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngineError";
  }

  /** The session endpoints answer 404/405/501 until the orchestrator (C2) lands. */
  get notImplemented(): boolean {
    return this.status === 404 || this.status === 405 || this.status === 501;
  }
}

export interface SessionMessage {
  from: "user" | "engine";
  text: string;
  at: number;
}

export interface SessionInfo {
  id: string;
  orchestratorAgentId: string;
  mode: "auto" | "manual";
  createdAt: number;
  runIds: string[];
}

export interface RunSummaryLite {
  id: string;
  repoUrl: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
}

export interface StartRunInput {
  target: string;
  mode: "auto" | "manual";
  chaos: string[];
  brief?: string;
}

/** `fixture:<dir>` replays a recorded run offline; anything else is a repo URL. */
export function runBodyFor(input: StartRunInput): Record<string, unknown> {
  const target = input.target.trim();
  const body: Record<string, unknown> = { mode: input.mode, chaos: input.chaos };
  if (target.startsWith("fixture:")) body.fixture = target.slice("fixture:".length).trim();
  else body.repoUrl = target;
  if (input.brief) body.brief = input.brief;
  return body;
}

export interface AssignmentSelection {
  role: SlotRole;
  agentId: string;
}

export class EngineClient {
  readonly engineUrl: string;

  constructor(private readonly pairing: Pairing) {
    this.engineUrl = normalizeEngineUrl(pairing.engineUrl);
  }

  get token(): string {
    return this.pairing.token;
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pairing.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.engineUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new EngineError(`cannot reach the engine at ${this.engineUrl}`, 0);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message =
        json && typeof json === "object" && "error" in json
          ? String((json as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
      throw new EngineError(message, response.status);
    }
    return json as T;
  }

  /** Cheap authenticated call used to prove the token works. */
  async checkPairing(): Promise<void> {
    await this.request("GET", "/runs");
  }

  async getConfig(): Promise<Config> {
    return (await this.request<{ config: Config }>("GET", "/config")).config;
  }

  createSession(input: { orchestratorAgentId?: string; mode: "auto" | "manual" }) {
    return this.request<SessionInfo>("POST", "/sessions", input);
  }

  sendMessage(sessionId: string, text: string) {
    return this.request<{ reply?: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { text },
    );
  }

  startRun(input: StartRunInput) {
    return this.request<{ id: string; status: string }>("POST", "/runs", runBodyFor(input));
  }

  killSlot(runId: string, role: string) {
    return this.request<{ ok: boolean; killed: boolean }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/slots/${encodeURIComponent(role)}/kill`,
    );
  }

  answerApproval(runId: string, approvalId: string, decision: "approve" | "deny", reason?: string) {
    return this.request<{ ok: boolean }>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision, ...(reason ? { reason } : {}) },
    );
  }

  setAssignments(runId: string, selections: AssignmentSelection[]) {
    return this.request<{ ok: boolean }>("POST", `/runs/${encodeURIComponent(runId)}/assignments`, {
      selections,
      confirmed: true,
    });
  }

  /** Stream the session transcript (SSE over fetch so the bearer header can be set). */
  streamSession(
    sessionId: string,
    onMessage: (message: SessionMessage) => void,
    onError: (error: Error) => void,
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${this.engineUrl}/sessions/${encodeURIComponent(sessionId)}/events`,
          {
            headers: { ...this.headers(), Accept: "text/event-stream" },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new EngineError(`session stream failed: ${response.status}`, response.status);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              onMessage(JSON.parse(line.slice(5).trim()) as SessionMessage);
            } catch {
              // Ignore keep-alive and malformed frames.
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted)
          onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return () => controller.abort();
  }
}
