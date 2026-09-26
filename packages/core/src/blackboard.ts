import type { z } from "zod";
import { BlackboardEntry, Evidence, TraceEvent } from "@punch/shared";

export { BlackboardEntry, Evidence };

/** Base error class for all blackboard errors. */
export class BlackboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlackboardError";
  }
}

/** Thrown when an operation attempts to overwrite an existing blackboard key without a valid new version. */
export class BlackboardOverwriteError extends BlackboardError {
  readonly key: string;
  readonly currentVersion: number;
  readonly attemptedVersion?: number;

  constructor(key: string, currentVersion: number, attemptedVersion?: number) {
    const detail =
      attemptedVersion !== undefined
        ? `attempted version ${attemptedVersion} <= current version ${currentVersion}`
        : `current version is ${currentVersion} and no new version was specified`;
    super(
      `Cannot overwrite blackboard key "${key}": keys are never overwritten (${detail}). To write an update, specify version ${currentVersion + 1}.`,
    );
    this.name = "BlackboardOverwriteError";
    this.key = key;
    this.currentVersion = currentVersion;
    this.attemptedVersion = attemptedVersion;
  }
}

/** Thrown when a blackboard entry fails schema validation on read or write. */
export class BlackboardValidationError extends BlackboardError {
  readonly key: string;
  readonly version?: number;
  readonly zodError: z.ZodError;

  constructor(key: string, zodError: z.ZodError, version?: number) {
    const ver = version !== undefined ? ` at version ${version}` : "";
    super(`Blackboard entry for key "${key}"${ver} failed schema validation: ${zodError.message}`);
    this.name = "BlackboardValidationError";
    this.key = key;
    this.version = version;
    this.zodError = zodError;
  }
}

/** Thrown when a requested blackboard key or version is not found. */
export class BlackboardNotFoundError extends BlackboardError {
  readonly key: string;
  readonly version?: number;

  constructor(key: string, version?: number) {
    const ver = version !== undefined ? ` at version ${version}` : "";
    super(`Blackboard entry for key "${key}"${ver} not found.`);
    this.name = "BlackboardNotFoundError";
    this.key = key;
    this.version = version;
  }
}

/** Writer identity for an entry. */
export interface EntryWriter {
  role: string;
  agentId: string;
  subtaskId?: string;
}

/** Input shape when writing to the blackboard. */
export interface WriteInput<T = unknown> {
  key: string;
  value: T;
  evidence: Evidence[];
  writtenBy: EntryWriter;
  status?: "ok" | "degraded";
  version?: number;
  ts?: number;
}

/** Trace sink interface for emitting trace events. */
export interface TraceSinkObject {
  emit?(event: TraceEvent): void | Promise<void>;
  write?(event: TraceEvent): void | Promise<void>;
}

export type TraceSink = TraceSinkObject | ((event: TraceEvent) => void | Promise<void>);

export interface BlackboardOptions {
  runId?: string;
  traceSink?: TraceSink;
  clock?: () => number;
}

export interface BlackboardFilter {
  status?: "ok" | "degraded";
  role?: string;
  agentId?: string;
  subtaskId?: string;
}

/** Options when retrieving inputs for a handoff packet. */
export interface GetInputsOptions {
  /** If true, missing keys are omitted from the returned record rather than throwing. Default false. */
  allowMissing?: boolean;
}

/** An immutable snapshot of the blackboard at a specific point in time. */
export class BlackboardSnapshot {
  readonly seq: number;
  readonly ts: number;
  readonly triggeredBy?: BlackboardEntry;
  private readonly _entries: ReadonlyMap<string, BlackboardEntry>;

  constructor(init: {
    seq: number;
    ts: number;
    triggeredBy?: BlackboardEntry;
    entries: Map<string, BlackboardEntry> | Record<string, BlackboardEntry>;
  }) {
    this.seq = init.seq;
    this.ts = init.ts;
    this.triggeredBy = init.triggeredBy ? Object.freeze({ ...init.triggeredBy }) : undefined;

    const map = new Map<string, BlackboardEntry>();
    if (init.entries instanceof Map) {
      for (const [k, v] of init.entries) {
        map.set(k, Object.freeze({ ...v }));
      }
    } else {
      for (const [k, v] of Object.entries(init.entries)) {
        map.set(k, Object.freeze({ ...v }));
      }
    }
    this._entries = map;
    Object.freeze(this);
  }

  /** Check if a key exists in this snapshot. */
  has(key: string): boolean {
    return this._entries.has(key);
  }

  /** Get an entry by key without schema validation. */
  get(key: string): BlackboardEntry | undefined;
  /** Get an entry by key with schema validation. */
  get<T>(
    key: string,
    schema: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | undefined;
  get<T = unknown>(
    key: string,
    schema?: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | BlackboardEntry | undefined {
    const entry = this._entries.get(key);
    if (!entry) return undefined;

    if (schema) {
      const parsed = schema.safeParse(entry.value);
      if (!parsed.success) {
        throw new BlackboardValidationError(key, parsed.error, entry.version);
      }
      return { ...entry, value: parsed.data };
    }

    return entry;
  }

  /** Read an entry by key without schema validation. Throws if missing. */
  read(key: string): BlackboardEntry;
  /** Read an entry by key with schema validation. Throws if missing or invalid. */
  read<T>(key: string, schema: z.ZodType<T>): Omit<BlackboardEntry, "value"> & { value: T };
  read<T = unknown>(
    key: string,
    schema?: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | BlackboardEntry {
    const entry = schema ? this.get(key, schema) : this.get(key);
    if (!entry) {
      throw new BlackboardNotFoundError(key);
    }
    return entry;
  }

  /** List all latest entries present in this snapshot. */
  list(): BlackboardEntry[] {
    return Array.from(this._entries.values());
  }

  /** List all keys present in this snapshot. */
  keys(): string[] {
    return Array.from(this._entries.keys());
  }

  /** Return all entries as a plain key-value map. */
  getAll(): Record<string, BlackboardEntry> {
    const result: Record<string, BlackboardEntry> = {};
    for (const [k, v] of this._entries) {
      result[k] = v;
    }
    return result;
  }

  /** Return the inputs subset required by a handoff packet (plan.md 2.4 inputs). */
  inputs(
    keysOrSubtask: string[] | { inputKeys: string[] },
    options: GetInputsOptions = {},
  ): Record<string, BlackboardEntry> {
    const keys = Array.isArray(keysOrSubtask) ? keysOrSubtask : keysOrSubtask.inputKeys;
    const result: Record<string, BlackboardEntry> = {};

    for (const key of keys) {
      const entry = this._entries.get(key);
      if (entry) {
        result[key] = entry;
      } else if (!options.allowMissing) {
        throw new BlackboardNotFoundError(key);
      }
    }

    return result;
  }

  /** JSON-serializable representation of this snapshot. */
  toJSON(): {
    seq: number;
    ts: number;
    triggeredBy?: BlackboardEntry;
    entries: Record<string, BlackboardEntry>;
  } {
    return {
      seq: this.seq,
      ts: this.ts,
      triggeredBy: this.triggeredBy,
      entries: this.getAll(),
    };
  }
}

/**
 * Blackboard: typed, evidence-linked, never overwritten, snapshot per write.
 * Manages run state, history, immutable snapshots, and emits blackboard.written trace events.
 */
export class Blackboard {
  private readonly runId: string;
  private readonly traceSink?: TraceSink;
  private readonly clock: () => number;
  private traceSeq = 0;

  /** Internal version storage: key -> array of versions in chronological order. */
  private readonly entriesByKey = new Map<string, BlackboardEntry[]>();
  /** Chronological history of all entries written. */
  private readonly writeHistory: BlackboardEntry[] = [];
  /** Immutable snapshots taken after each write. */
  private readonly snapshotHistory: BlackboardSnapshot[] = [];

  constructor(options: BlackboardOptions = {}) {
    this.runId = options.runId ?? "run-0";
    this.traceSink = options.traceSink;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Total number of unique keys written to the blackboard. */
  get size(): number {
    return this.entriesByKey.size;
  }

  /** Returns all immutable snapshots taken on each write. */
  get snapshots(): readonly BlackboardSnapshot[] {
    return this.snapshotHistory;
  }

  /** Returns all snapshots taken on each write. */
  getSnapshots(): readonly BlackboardSnapshot[] {
    return this.snapshotHistory;
  }

  /** Retrieve a snapshot by its sequence number (1-indexed). */
  getSnapshot(seq: number): BlackboardSnapshot | undefined {
    return this.snapshotHistory.find((s) => s.seq === seq);
  }

  /** Returns the most recent snapshot, or undefined if no writes have occurred yet. */
  get latestSnapshot(): BlackboardSnapshot | undefined {
    return this.snapshotHistory[this.snapshotHistory.length - 1];
  }

  /**
   * Returns a snapshot of the current blackboard state.
   * If writes have occurred, returns the latest snapshot.
   * If no writes have occurred, returns a fresh empty snapshot (seq: 0).
   */
  snapshot(): BlackboardSnapshot {
    if (this.latestSnapshot) {
      return this.latestSnapshot;
    }
    return new BlackboardSnapshot({
      seq: 0,
      ts: this.clock(),
      entries: new Map(),
    });
  }

  /** Check if a key exists on the blackboard. */
  has(key: string): boolean {
    return this.entriesByKey.has(key);
  }

  /**
   * Write an entry to the blackboard.
   *
   * Keys are never overwritten:
   * - A second write to an existing key without specifying a new version is an error.
   * - Specifying version <= currentVersion is an error.
   * - A new version must be strictly currentVersion + 1.
   *
   * Emits a `blackboard.written` trace event to the injected trace sink.
   * Creates an immutable snapshot for this write.
   */
  write<T = unknown>(input: WriteInput<T> | BlackboardEntry): BlackboardEntry {
    const existingVersions = this.entriesByKey.get(input.key);
    const currentEntry = existingVersions
      ? existingVersions[existingVersions.length - 1]
      : undefined;

    let targetVersion: number;

    if (!currentEntry) {
      // First write for this key
      if (input.version !== undefined && input.version !== 1) {
        throw new BlackboardError(
          `Invalid initial version ${input.version} for key "${input.key}": first version must be 1.`,
        );
      }
      targetVersion = 1;
    } else {
      // Key already exists
      const currentVersion = currentEntry.version;
      if (input.version === undefined) {
        throw new BlackboardOverwriteError(input.key, currentVersion);
      }
      if (input.version <= currentVersion) {
        throw new BlackboardOverwriteError(input.key, currentVersion, input.version);
      }
      if (input.version !== currentVersion + 1) {
        throw new BlackboardError(
          `Invalid version ${input.version} for key "${input.key}": expected sequential next version ${currentVersion + 1}.`,
        );
      }
      targetVersion = input.version;
    }

    const rawEntry = {
      key: input.key,
      version: targetVersion,
      status: input.status ?? "ok",
      value: input.value,
      evidence: input.evidence,
      writtenBy: input.writtenBy,
      ts: input.ts ?? this.clock(),
    };

    // Validate against BlackboardEntry schema
    const parseResult = BlackboardEntry.safeParse(rawEntry);
    if (!parseResult.success) {
      throw new BlackboardValidationError(input.key, parseResult.error, targetVersion);
    }
    const entry = Object.freeze(parseResult.data);

    // Store in version history
    if (!existingVersions) {
      this.entriesByKey.set(input.key, [entry]);
    } else {
      existingVersions.push(entry);
    }
    this.writeHistory.push(entry);

    // Create an immutable snapshot for this write
    const snapshot = new BlackboardSnapshot({
      seq: this.snapshotHistory.length + 1,
      ts: entry.ts,
      triggeredBy: entry,
      entries: this.getAll(),
    });
    this.snapshotHistory.push(snapshot);

    // Emit blackboard.written trace event to injected trace sink
    this.emitWrittenEvent(entry);

    return entry;
  }

  /**
   * Helper to write a new version of an existing or new key.
   * Automatically computes the next version: 1 if new, currentVersion + 1 if existing.
   */
  writeNewVersion<T = unknown>(input: Omit<WriteInput<T>, "version">): BlackboardEntry {
    const existing = this.entriesByKey.get(input.key);
    const nextVersion = existing ? existing[existing.length - 1]!.version + 1 : 1;
    return this.write({ ...input, version: nextVersion });
  }

  /**
   * Helper to write an entry with status: "degraded".
   */
  writeDegraded<T = unknown>(input: Omit<WriteInput<T>, "status">): BlackboardEntry {
    return this.write({ ...input, status: "degraded" });
  }

  /** Read the latest entry for a key without schema validation. */
  get(key: string): BlackboardEntry | undefined;
  /** Read the latest entry for a key with schema validation. */
  get<T>(
    key: string,
    schema: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | undefined;
  get<T = unknown>(
    key: string,
    schema?: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | BlackboardEntry | undefined {
    const versions = this.entriesByKey.get(key);
    if (!versions || versions.length === 0) return undefined;
    const entry = versions[versions.length - 1]!;

    if (schema) {
      const parsed = schema.safeParse(entry.value);
      if (!parsed.success) {
        throw new BlackboardValidationError(key, parsed.error, entry.version);
      }
      return { ...entry, value: parsed.data };
    }

    return entry;
  }

  /** Read the latest entry for a key without schema validation. Throws if missing. */
  read(key: string): BlackboardEntry;
  /** Read the latest entry for a key with schema validation. Throws if missing or invalid. */
  read<T>(key: string, schema: z.ZodType<T>): Omit<BlackboardEntry, "value"> & { value: T };
  read<T = unknown>(
    key: string,
    schema?: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | BlackboardEntry {
    const entry = schema ? this.get(key, schema) : this.get(key);
    if (!entry) {
      throw new BlackboardNotFoundError(key);
    }
    return entry;
  }

  /** Read a specific historical version of a key without schema validation. */
  getVersion(key: string, version: number): BlackboardEntry | undefined;
  /** Read a specific historical version of a key with schema validation. */
  getVersion<T>(
    key: string,
    version: number,
    schema: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | undefined;
  getVersion<T = unknown>(
    key: string,
    version: number,
    schema?: z.ZodType<T>,
  ): (Omit<BlackboardEntry, "value"> & { value: T }) | BlackboardEntry | undefined {
    const versions = this.entriesByKey.get(key);
    if (!versions) return undefined;
    const entry = versions.find((v) => v.version === version);
    if (!entry) return undefined;

    if (schema) {
      const parsed = schema.safeParse(entry.value);
      if (!parsed.success) {
        throw new BlackboardValidationError(key, parsed.error, entry.version);
      }
      return { ...entry, value: parsed.data };
    }

    return entry;
  }

  /**
   * Return all versions for a key in ascending chronological order.
   * Returns an empty array if the key does not exist.
   */
  getHistory(key: string): BlackboardEntry[] {
    const versions = this.entriesByKey.get(key);
    return versions ? [...versions] : [];
  }

  /**
   * Listing API: return the latest entry for each key, optionally matching filter criteria.
   */
  list(filter?: BlackboardFilter): BlackboardEntry[] {
    const entries: BlackboardEntry[] = [];
    for (const versions of this.entriesByKey.values()) {
      const latest = versions[versions.length - 1];
      if (!latest) continue;

      if (filter) {
        if (filter.status && latest.status !== filter.status) continue;
        if (filter.role && latest.writtenBy.role !== filter.role) continue;
        if (filter.agentId && latest.writtenBy.agentId !== filter.agentId) continue;
        if (filter.subtaskId && latest.writtenBy.subtaskId !== filter.subtaskId) continue;
      }
      entries.push(latest);
    }
    return entries;
  }

  /**
   * List all unique keys currently stored.
   */
  listKeys(): string[] {
    return Array.from(this.entriesByKey.keys());
  }

  /**
   * Return chronological history of all writes across all keys, or for a specific key.
   */
  listHistory(key?: string): BlackboardEntry[] {
    if (key !== undefined) {
      return this.getHistory(key);
    }
    return [...this.writeHistory];
  }

  /**
   * Return a dictionary of key -> latest entry for all stored keys.
   */
  getAll(): Record<string, BlackboardEntry> {
    const result: Record<string, BlackboardEntry> = {};
    for (const [key, versions] of this.entriesByKey) {
      const latest = versions[versions.length - 1];
      if (latest) {
        result[key] = latest;
      }
    }
    return result;
  }

  /**
   * Return the inputs subset required by a handoff packet (plan.md 2.4 inputs).
   * Accepts either an array of string keys or an object containing `inputKeys` (such as Subtask).
   * Throws BlackboardNotFoundError if any requested key is missing, unless `allowMissing: true`.
   */
  getInputs(
    keysOrSubtask: string[] | { inputKeys: string[] },
    options: GetInputsOptions = {},
  ): Record<string, BlackboardEntry> {
    const keys = Array.isArray(keysOrSubtask) ? keysOrSubtask : keysOrSubtask.inputKeys;
    const result: Record<string, BlackboardEntry> = {};

    for (const key of keys) {
      const entry = this.get(key);
      if (entry) {
        result[key] = entry;
      } else if (!options.allowMissing) {
        throw new BlackboardNotFoundError(key);
      }
    }

    return result;
  }

  /** Alias for getInputs (plan.md 2.4 inputs). */
  inputs(
    keysOrSubtask: string[] | { inputKeys: string[] },
    options?: GetInputsOptions,
  ): Record<string, BlackboardEntry> {
    return this.getInputs(keysOrSubtask, options);
  }

  /** Emit a blackboard.written trace event to the injected trace sink. */
  private emitWrittenEvent(entry: BlackboardEntry): void {
    if (!this.traceSink) return;

    const event: TraceEvent = {
      runId: this.runId,
      seq: this.traceSeq++,
      ts: entry.ts,
      kind: "blackboard.written",
      key: entry.key,
      entry,
    };

    // Validate event structure
    TraceEvent.parse(event);

    if (typeof this.traceSink === "function") {
      void this.traceSink(event);
    } else if (typeof this.traceSink.emit === "function") {
      void this.traceSink.emit(event);
    } else if (typeof this.traceSink.write === "function") {
      void this.traceSink.write(event);
    }
  }
}
