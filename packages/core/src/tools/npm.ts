import { z } from "zod";
import { fetchWithRetry, type HttpResponse } from "./http.js";
import type { TraceEvent } from "@punch/shared";

export const NpmVersionMetadataSchema = z.object({
  name: z.string().optional(),
  version: z.string(),
  description: z.string().optional(),
  main: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  dist: z
    .object({
      tarball: z.string().optional(),
      shasum: z.string().optional(),
      integrity: z.string().optional(),
    })
    .optional(),
  deprecated: z.union([z.string(), z.boolean()]).optional(),
});
export type NpmVersionMetadata = z.infer<typeof NpmVersionMetadataSchema>;

export const NpmPackageMetadataSchema = z.object({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).default({}),
  versions: z.record(z.string(), z.union([NpmVersionMetadataSchema, z.unknown()])).default({}),
  time: z.record(z.string(), z.string()).optional().default({}),
  description: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  repository: z
    .union([
      z.string(),
      z.object({
        type: z.string().optional(),
        url: z.string().optional(),
        directory: z.string().optional(),
      }),
    ])
    .optional(),
});
export type NpmPackageMetadata = z.infer<typeof NpmPackageMetadataSchema>;

export interface NpmClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  traceSink?: (event: TraceEvent) => unknown;
}

export class NpmClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly traceSink?: (event: TraceEvent) => unknown;

  constructor(options: NpmClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch;
    this.traceSink = options.traceSink;
  }

  /**
   * Fetches package metadata from npm registry.
   */
  async getPackageMetadata(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse<NpmPackageMetadata>> {
    // Correctly escape scoped packages like @foo/bar -> @foo%2Fbar
    const encodedName = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const url = `${this.baseUrl}/${encodedName}`;

    return fetchWithRetry({
      url,
      method: "GET",
      headers: {
        Accept: "application/vnd.npm.install-v1+json, application/json",
        "User-Agent": "punch-dependency-triage/1.0",
      },
      schema: NpmPackageMetadataSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "npm_package_metadata",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });
  }

  /**
   * Returns a list of all available versions and dist-tags for a package.
   */
  async getVersions(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<{
    name: string;
    latest?: string;
    distTags: Record<string, string>;
    versions: string[];
  }> {
    const res = await this.getPackageMetadata(packageName, signal);
    const distTags = res.data["dist-tags"] || {};
    const versions = Object.keys(res.data.versions || {});

    return {
      name: res.data.name,
      latest: distTags["latest"],
      distTags,
      versions,
    };
  }
}
