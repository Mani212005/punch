import { z } from "zod";
import { fetchWithRetry, type HttpResponse } from "./http.js";
import type { TraceEvent } from "@punch/shared";

export const OSVAffectedRangeEventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
  limit: z.string().optional(),
});

export const OSVAffectedRangeSchema = z.object({
  type: z.string(),
  repo: z.string().optional(),
  events: z.array(OSVAffectedRangeEventSchema).default([]),
});

export const OSVAffectedPackageSchema = z.object({
  name: z.string().optional(),
  ecosystem: z.string().optional(),
  purl: z.string().optional(),
});

export const OSVAffectedSchema = z.object({
  package: OSVAffectedPackageSchema.optional(),
  ranges: z.array(OSVAffectedRangeSchema).optional().default([]),
  versions: z.array(z.string()).optional().default([]),
  ecosystem_specific: z.unknown().optional(),
  database_specific: z.unknown().optional(),
});

export const OSVSeveritySchema = z.object({
  type: z.string(),
  score: z.string(),
});

export const OSVReferenceSchema = z.object({
  type: z.string().optional(),
  url: z.string(),
});

export const OSVVulnerabilitySchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  details: z.string().optional(),
  aliases: z.array(z.string()).optional().default([]),
  modified: z.string().optional(),
  published: z.string().optional(),
  affected: z.array(OSVAffectedSchema).optional().default([]),
  severity: z.array(OSVSeveritySchema).optional().default([]),
  references: z.array(OSVReferenceSchema).optional().default([]),
  schema_version: z.string().optional(),
});
export type OSVVulnerability = z.infer<typeof OSVVulnerabilitySchema>;

export const OSVQueryResponseSchema = z.object({
  vulns: z.array(OSVVulnerabilitySchema).optional().default([]),
});
export type OSVQueryResponse = z.infer<typeof OSVQueryResponseSchema>;

export const OSVBatchResultItemSchema = z.object({
  vulns: z.array(OSVVulnerabilitySchema).optional().default([]),
});

export const OSVBatchResponseSchema = z.object({
  results: z.array(OSVBatchResultItemSchema).default([]),
});
export type OSVBatchResponse = z.infer<typeof OSVBatchResponseSchema>;

export interface OSVClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  traceSink?: (event: TraceEvent) => unknown;
}

export interface OSVQueryInput {
  package: {
    name: string;
    ecosystem?: string;
  };
  version?: string;
  commit?: string;
}

export class OSVClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly traceSink?: (event: TraceEvent) => unknown;

  constructor(options: OSVClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.osv.dev/v1").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch;
    this.traceSink = options.traceSink;
  }

  /**
   * Queries OSV for vulnerabilities affecting a single package / version.
   */
  async query(input: OSVQueryInput, signal?: AbortSignal): Promise<HttpResponse<OSVQueryResponse>> {
    const url = `${this.baseUrl}/query`;
    const payload = {
      package: {
        name: input.package.name,
        ecosystem: input.package.ecosystem ?? "npm",
      },
      version: input.version,
      commit: input.commit,
    };

    const res = await fetchWithRetry({
      url,
      method: "POST",
      body: payload,
      schema: OSVQueryResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "osv_query",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });

    // Ensure vulns is always an array
    if (!res.data.vulns) {
      res.data.vulns = [];
    }

    return res;
  }

  /**
   * Batch queries OSV for multiple package vulnerabilities in a single HTTP request.
   */
  async queryBatch(
    queries: OSVQueryInput[],
    signal?: AbortSignal,
  ): Promise<HttpResponse<OSVBatchResponse>> {
    const url = `${this.baseUrl}/querybatch`;
    const payload = {
      queries: queries.map((q) => ({
        package: {
          name: q.package.name,
          ecosystem: q.package.ecosystem ?? "npm",
        },
        version: q.version,
        commit: q.commit,
      })),
    };

    const res = await fetchWithRetry({
      url,
      method: "POST",
      body: payload,
      schema: OSVBatchResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "osv_query_batch",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });

    return res;
  }
}
