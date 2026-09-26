import type { TraceEvent } from "@punch/shared";
import { TraceEvent as TraceEventSchema } from "@punch/shared";

export type EventSourceKind = "static" | "file" | "sse" | "viewer-tunnel";

export interface TraceEventSource {
  readonly id: string;
  readonly kind: EventSourceKind;
  subscribe(
    onEvent: (event: TraceEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void,
  ): () => void;
  fetchAll?(): Promise<TraceEvent[]>;
}

export function parseJsonlEvents(text: string): TraceEvent[] {
  const lines = text.split("\n");
  const events: TraceEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      const parsed = TraceEventSchema.parse(raw);
      events.push(parsed);
    } catch {
      // If parsing fails on an empty or corrupt line, skip
    }
  }

  return events;
}

export class StaticFileEventSource implements TraceEventSource {
  readonly kind = "static" as const;
  readonly id: string;
  private readonly url: string;

  constructor(traceId: string, basePath = "/traces") {
    this.id = traceId;
    const cleanId = traceId.endsWith(".jsonl") ? traceId : `${traceId}.jsonl`;
    this.url =
      traceId.startsWith("http://") || traceId.startsWith("https://")
        ? traceId
        : `${basePath.replace(/\/$/, "")}/${cleanId}`;
  }

  async fetchAll(): Promise<TraceEvent[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch trace file from ${this.url}: ${response.status} ${response.statusText}`,
      );
    }
    const text = await response.text();
    return parseJsonlEvents(text);
  }

  subscribe(
    onEvent: (event: TraceEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void,
  ): () => void {
    let cancelled = false;

    this.fetchAll()
      .then((events) => {
        if (cancelled) return;
        for (const event of events) {
          if (cancelled) break;
          onEvent(event);
        }
        if (!cancelled && onComplete) {
          onComplete();
        }
      })
      .catch((err) => {
        if (!cancelled && onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
    };
  }
}

export class LocalFileEventSource implements TraceEventSource {
  readonly kind = "file" as const;
  readonly id: string;
  private readonly file: File;

  constructor(file: File) {
    this.file = file;
    this.id = file.name;
  }

  async fetchAll(): Promise<TraceEvent[]> {
    if (typeof (this.file as { text?: () => Promise<string> }).text === "function") {
      const text = await this.file.text();
      return parseJsonlEvents(text);
    }
    if (typeof FileReader !== "undefined") {
      return new Promise<TraceEvent[]>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve(parseJsonlEvents(reader.result as string));
        };
        reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
        reader.readAsText(this.file);
      });
    }
    const text = String(this.file);
    return parseJsonlEvents(text);
  }

  subscribe(
    onEvent: (event: TraceEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void,
  ): () => void {
    let cancelled = false;

    this.fetchAll()
      .then((events) => {
        if (cancelled) return;
        for (const event of events) {
          if (cancelled) break;
          onEvent(event);
        }
        if (!cancelled && onComplete) {
          onComplete();
        }
      })
      .catch((err) => {
        if (!cancelled && onError) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
    };
  }
}

export class SSEEventSource implements TraceEventSource {
  readonly kind = "sse" as const;
  readonly id: string;
  private readonly engineUrl: string;
  private readonly token: string;
  private readonly runId?: string;

  constructor(engineUrl: string, token: string, runId?: string) {
    this.engineUrl = engineUrl.replace(/\/$/, "");
    this.token = token;
    this.runId = runId;
    this.id = runId ?? "live";
  }

  getEndpointUrl(): string {
    if (this.runId) {
      return `${this.engineUrl}/runs/${this.runId}/events`;
    }
    return `${this.engineUrl}/runs/current/events`;
  }

  async fetchAll(): Promise<TraceEvent[]> {
    const traceUrl = this.runId
      ? `${this.engineUrl}/runs/${this.runId}/trace`
      : `${this.engineUrl}/runs/current/trace`;

    const headers: Record<string, string> = {};
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(traceUrl, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch trace from ${traceUrl}: ${response.status}`);
    }
    const text = await response.text();
    return parseJsonlEvents(text);
  }

  subscribe(
    onEvent: (event: TraceEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void,
  ): () => void {
    const controller = new AbortController();
    const endpoint = this.getEndpointUrl();

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    fetch(endpoint, {
      headers,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `SSE stream connection failed: ${response.status} ${response.statusText}`,
          );
        }
        if (!response.body) {
          throw new Error("No response body received from SSE stream");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === "[DONE]") {
                onComplete?.();
                return;
              }
              try {
                const parsedJson = JSON.parse(dataStr);
                const event = TraceEventSchema.parse(parsedJson);
                onEvent(event);
              } catch {
                // Ignore parse errors on ping/keep-alive frames
              }
            }
          }
        }

        onComplete?.();
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      controller.abort();
    };
  }
}

export class ViewerTunnelEventSource implements TraceEventSource {
  readonly kind = "viewer-tunnel" as const;
  readonly id: string;
  private readonly engineBase: string;
  private readonly runId: string;
  private readonly viewerToken: string;

  /**
   * Read-only live source through a `punch serve --tunnel` public URL.
   * Hits the same viewer-token routes as the paired SSE source
   * (`GET /runs/:id/events`, `GET /runs/:id/trace`) with the token as
   * `?token=`, since remote viewers cannot always set headers. Never sends
   * the pairing token and never touches a control route.
   */
  constructor(engineBase: string, runId: string, viewerToken: string) {
    this.engineBase = engineBase.replace(/\/$/, "");
    this.runId = runId;
    this.viewerToken = viewerToken;
    this.id = `viewer:${runId}`;
  }

  getEndpointUrl(): string {
    return `${this.engineBase}/runs/${encodeURIComponent(this.runId)}/events?token=${encodeURIComponent(this.viewerToken)}`;
  }

  getTraceUrl(): string {
    return `${this.engineBase}/runs/${encodeURIComponent(this.runId)}/trace?token=${encodeURIComponent(this.viewerToken)}`;
  }

  async fetchAll(): Promise<TraceEvent[]> {
    const traceUrl = this.getTraceUrl();
    const response = await fetch(traceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch viewer trace from ${traceUrl}: ${response.status}`);
    }
    const text = await response.text();
    return parseJsonlEvents(text);
  }

  subscribe(
    onEvent: (event: TraceEvent) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void,
  ): () => void {
    const controller = new AbortController();
    const endpoint = this.getEndpointUrl();

    fetch(endpoint, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Tunnel stream failed: ${response.status}`);
        }
        if (!response.body) {
          throw new Error("No response body received from tunnel stream");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === "[DONE]") {
                onComplete?.();
                return;
              }
              try {
                const parsedJson = JSON.parse(dataStr);
                const event = TraceEventSchema.parse(parsedJson);
                onEvent(event);
              } catch {
                // Ignore parse errors on keep-alive
              }
            }
          }
        }

        onComplete?.();
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      controller.abort();
    };
  }
}

export type EventSourceConfig =
  | { kind: "static"; traceId: string; basePath?: string }
  | { kind: "file"; file: File }
  | { kind: "sse"; engineUrl: string; token: string; runId?: string }
  | { kind: "viewer-tunnel"; engineBase: string; runId: string; viewerToken: string };

export function createEventSource(config: EventSourceConfig): TraceEventSource {
  switch (config.kind) {
    case "static":
      return new StaticFileEventSource(config.traceId, config.basePath);
    case "file":
      return new LocalFileEventSource(config.file);
    case "sse":
      return new SSEEventSource(config.engineUrl, config.token, config.runId);
    case "viewer-tunnel":
      return new ViewerTunnelEventSource(config.engineBase, config.runId, config.viewerToken);
  }
}

export interface ParsedViewerUrl {
  /** Engine/tunnel base, e.g. https://abc.trycloudflare.com */
  engineBase: string;
  /** Run id when the URL names one, else null. */
  runId: string | null;
  /** Viewer token from `?token=`, else null. */
  token: string | null;
}

/**
 * Parse anything the Watch page's viewer-URL input accepts: the base viewer
 * URL printed by `punch serve --tunnel`, a per-run events/trace URL, or a
 * bare base URL. Never throws: unparseable input yields empty fields the UI
 * reports back to the viewer.
 */
export function parseViewerUrl(input: string): ParsedViewerUrl {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const token = url.searchParams.get("token");
    const runMatch = /\/runs\/([^/]+)\/(events|trace)\/?$/.exec(url.pathname);
    const engineBase = `${url.protocol}//${url.host}`;
    return {
      engineBase,
      runId: runMatch?.[1] ? decodeURIComponent(runMatch[1]) : null,
      token,
    };
  } catch {
    return { engineBase: "", runId: null, token: null };
  }
}
