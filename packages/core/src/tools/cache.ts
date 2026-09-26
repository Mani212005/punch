import { createHash } from "node:crypto";
import type { ToolResultSummary } from "@punch/shared";

/**
 * Deterministically serializes any JavaScript object or primitive into canonical JSON
 * with sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([_, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  const serialized = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);

  return "{" + serialized.join(",") + "}";
}

/**
 * Computes a deterministic SHA-256 hash for a tool name and its input arguments.
 */
export function computeInputHash(tool: string, input: unknown): string {
  const canonical = canonicalJson(input);
  return createHash("sha256").update(`${tool}:${canonical}`).digest("hex");
}

export interface CacheEntry {
  tool: string;
  inputHash: string;
  input: unknown;
  output: unknown;
  createdAt: number;
}

/**
 * Per-run tool execution cache.
 * Provides fast retrieval of previously executed tool calls,
 * feeds handoff packets across agent takeovers, and records summaries.
 */
export class ToolCache {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Retrieves a cached result if present.
   */
  get<T = unknown>(
    tool: string,
    input: unknown,
  ): { hit: true; output: T; inputHash: string } | { hit: false; inputHash: string } {
    const inputHash = computeInputHash(tool, input);
    const entry = this.entries.get(inputHash);

    if (entry !== undefined) {
      return {
        hit: true,
        output: entry.output as T,
        inputHash,
      };
    }

    return {
      hit: false,
      inputHash,
    };
  }

  /**
   * Stores a tool result in the cache.
   * Returns the computed inputHash.
   */
  set(tool: string, input: unknown, output: unknown): string {
    const inputHash = computeInputHash(tool, input);
    this.entries.set(inputHash, {
      tool,
      inputHash,
      input,
      output,
      createdAt: Date.now(),
    });
    return inputHash;
  }

  /**
   * Checks if an entry exists for the given tool and input.
   */
  has(tool: string, input: unknown): boolean {
    const inputHash = computeInputHash(tool, input);
    return this.entries.has(inputHash);
  }

  /**
   * Returns all cached tool result summaries matching the ToolResultSummary schema
   * needed by handoff packets (plan.md 2.4).
   */
  getSummaries(): ToolResultSummary[] {
    return Array.from(this.entries.values()).map((entry) => ({
      tool: entry.tool,
      inputHash: entry.inputHash,
      input: entry.input,
      output: entry.output,
    }));
  }

  /**
   * Hydrates the cache from an array of ToolResultSummary objects (e.g. from a handoff packet).
   */
  hydrate(summaries: ToolResultSummary[]): void {
    for (const summary of summaries) {
      this.entries.set(summary.inputHash, {
        tool: summary.tool,
        inputHash: summary.inputHash,
        input: summary.input,
        output: summary.output,
        createdAt: Date.now(),
      });
    }
  }

  /**
   * Number of items currently stored in cache.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Clears all cache entries.
   */
  clear(): void {
    this.entries.clear();
  }
}
