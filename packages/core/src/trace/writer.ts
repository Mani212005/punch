import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { TraceEvent } from "@punch/shared";

export interface RedactOptions {
  apiKeyEnvs?: string[];
  additionalSecrets?: string[];
  env?: Record<string, string | undefined>;
}

export interface TraceWriterOptions extends RedactOptions {
  runId?: string;
  filePath?: string;
  dir?: string;
  autoSeq?: boolean;
  now?: () => number;
  validateOnWrite?: boolean;
}

export type TraceSubscriber = (event: TraceEvent) => void;

export type TraceEventInput =
  | TraceEvent
  | (Omit<TraceEvent, "runId" | "seq" | "ts"> & {
      runId?: string;
      seq?: number;
      ts?: number;
    });

const SENSITIVE_KEY_REGEX =
  /^(?:authorization|proxy-authorization|api[-_]?key|secret|password|token|access[-_]?token|refresh[-_]?token|private[-_]?key)$/i;

const AUTH_HEADER_STRING_REGEX =
  /((?:authorization|proxy-authorization)\s*:\s*)(?:(?:basic|bearer|token|digest)\s+)?[^\r\n,;'"]+/gi;
const BEARER_REGEX = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const URL_SENSITIVE_PARAM_REGEX =
  /([?&](?:api[-_]?key|key|token|access[-_]?token|secret)=)[^&\s]*/gi;

const COMMON_KEY_PATTERNS = [
  /\b(sk-ant-[a-zA-Z0-9_-]{10,})\b/g,
  /\b(sk-proj-[a-zA-Z0-9_-]{10,})\b/g,
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(xai-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,40})\b/g,
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g,
  /\b(gh[ousr]_[a-zA-Z0-9]{36,})\b/g,
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(str: string, exactSecrets: string[] = []): string {
  let result = str;

  // 1. Exact secrets
  for (const secret of exactSecrets) {
    if (secret && secret.length >= 4) {
      const regex = new RegExp(escapeRegExp(secret), "g");
      result = result.replace(regex, "[REDACTED]");
    }
  }

  // 2. Auth header format in strings
  result = result.replace(AUTH_HEADER_STRING_REGEX, "$1[REDACTED]");

  // 3. Bearer tokens (standalone or in text)
  result = result.replace(BEARER_REGEX, "Bearer [REDACTED]");

  // 4. Common API key patterns
  for (const pattern of COMMON_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }

  // 5. Sensitive query params
  result = result.replace(URL_SENSITIVE_PARAM_REGEX, "$1[REDACTED]");

  return result;
}

export function redactSecrets(value: unknown, options?: RedactOptions): unknown {
  const env = options?.env ?? process.env;
  const exactSecrets: string[] = [];

  if (options?.apiKeyEnvs) {
    for (const envName of options.apiKeyEnvs) {
      const val = env[envName];
      if (typeof val === "string" && val.trim().length >= 4) {
        exactSecrets.push(val.trim());
      }
    }
  }

  if (options?.additionalSecrets) {
    for (const secret of options.additionalSecrets) {
      if (typeof secret === "string" && secret.trim().length >= 4) {
        exactSecrets.push(secret.trim());
      }
    }
  }

  exactSecrets.sort((a, b) => b.length - a.length);

  function deepRedact(val: unknown, visited: WeakSet<object>): unknown {
    if (typeof val === "string") {
      return redactString(val, exactSecrets);
    }
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (val instanceof Date) {
      return val;
    }
    if (visited.has(val)) {
      return "[Circular]";
    }
    visited.add(val);

    if (Array.isArray(val)) {
      return val.map((item) => deepRedact(item, visited));
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = deepRedact(v, visited);
      }
    }
    return result;
  }

  return deepRedact(value, new WeakSet());
}

export class TraceWriter {
  readonly runId: string;
  readonly filePath: string;
  private nextSeq = 0;
  private readonly now: () => number;
  private readonly validateOnWrite: boolean;
  private readonly redactOptions: RedactOptions;
  private readonly subscribers = new Set<TraceSubscriber>();
  private readonly inMemoryEvents: TraceEvent[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private isClosed = false;

  constructor(options: TraceWriterOptions = {}) {
    this.runId = options.runId ?? `run-${Date.now()}`;
    const baseDir = options.dir ?? "runs";
    this.filePath = options.filePath ?? path.join(baseDir, this.runId, "trace.jsonl");
    this.now = options.now ?? (() => Date.now());
    this.validateOnWrite = options.validateOnWrite ?? true;
    this.redactOptions = {
      apiKeyEnvs: options.apiKeyEnvs,
      additionalSecrets: options.additionalSecrets,
      env: options.env,
    };
  }

  getSeq(): number {
    return this.nextSeq;
  }

  getEvents(): TraceEvent[] {
    return [...this.inMemoryEvents];
  }

  subscribe(subscriber: TraceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async write(input: TraceEventInput): Promise<TraceEvent> {
    if (this.isClosed) {
      throw new Error("Cannot write to closed TraceWriter");
    }

    const seq = input.seq !== undefined ? input.seq : this.nextSeq++;
    if (input.seq !== undefined && input.seq >= this.nextSeq) {
      this.nextSeq = input.seq + 1;
    }

    const rawEvent = {
      ...input,
      runId: input.runId ?? this.runId,
      seq,
      ts: input.ts ?? this.now(),
    };

    // Redact secrets
    const redacted = redactSecrets(rawEvent, this.redactOptions);

    // Validate schema
    let event: TraceEvent;
    if (this.validateOnWrite) {
      event = TraceEvent.parse(redacted);
    } else {
      event = redacted as TraceEvent;
    }

    this.inMemoryEvents.push(event);

    // Queue file append
    const line = JSON.stringify(event) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.appendFile(this.filePath, line, "utf-8");
    });

    await this.writeQueue;

    // Notify subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error("TraceWriter subscriber error:", err);
      }
    }

    return event;
  }

  async append(input: TraceEventInput): Promise<TraceEvent> {
    return this.write(input);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async close(): Promise<void> {
    this.isClosed = true;
    await this.flush();
    this.subscribers.clear();
  }
}

export function parseTrace(jsonlContent: string): TraceEvent[] {
  const lines = jsonlContent.split("\n");
  const events: TraceEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      throw new Error(`Failed to parse JSON on line ${i + 1}: ${(err as Error).message}`);
    }

    try {
      const event = TraceEvent.parse(parsedJson);
      events.push(event);
    } catch (err) {
      throw new Error(`Invalid trace event schema on line ${i + 1}: ${(err as Error).message}`);
    }
  }

  return events;
}

export async function readTrace(filePath: string): Promise<TraceEvent[]> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  return parseTrace(content);
}

export async function* readTraceStream(filePath: string): AsyncIterable<TraceEvent> {
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse JSON on line ${lineNumber}: ${(err as Error).message}`);
    }

    try {
      yield TraceEvent.parse(parsedJson);
    } catch (err) {
      throw new Error(
        `Invalid trace event schema on line ${lineNumber}: ${(err as Error).message}`,
      );
    }
  }
}
