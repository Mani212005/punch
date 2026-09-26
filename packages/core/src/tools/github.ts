import { z } from "zod";
import { fetchWithRetry, type HttpResponse } from "./http.js";
import type { TraceEvent } from "@punch/shared";

// Response schemas for GitHub API endpoints
export const GitHubFileContentSchema = z.object({
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  url: z.string().optional(),
  html_url: z.string().nullable().optional(),
  git_url: z.string().optional(),
  download_url: z.string().nullable().optional(),
  type: z.string(),
  content: z.string().optional(),
  encoding: z.string().optional(),
});
export type GitHubFileContent = z.infer<typeof GitHubFileContentSchema>;

export const GitHubDirectoryContentSchema = z.array(
  z.object({
    name: z.string(),
    path: z.string(),
    sha: z.string(),
    size: z.number(),
    type: z.string(),
    download_url: z.string().nullable().optional(),
  }),
);
export type GitHubDirectoryContent = z.infer<typeof GitHubDirectoryContentSchema>;

export const GitHubContentResponseSchema = z.union([
  GitHubFileContentSchema,
  GitHubDirectoryContentSchema,
]);
export type GitHubContentResponse = z.infer<typeof GitHubContentResponseSchema>;

export const GitHubReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  created_at: z.string().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string().optional(),
});
export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

export const GitHubReleasesResponseSchema = z.array(GitHubReleaseSchema);
export type GitHubReleasesResponse = z.infer<typeof GitHubReleasesResponseSchema>;

export const GitHubCommitInfoSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({
        name: z.string().optional(),
        date: z.string().optional(),
      })
      .optional(),
  }),
});

export const GitHubCompareResponseSchema = z.object({
  status: z.string().optional(),
  ahead_by: z.number().int().optional(),
  behind_by: z.number().int().optional(),
  total_commits: z.number().int().optional(),
  commits: z.array(GitHubCommitInfoSchema).default([]),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string().optional(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
        changes: z.number().optional(),
        patch: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});
export type GitHubCompareResponse = z.infer<typeof GitHubCompareResponseSchema>;

export const GitHubIssueResponseSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.string(),
  created_at: z.string(),
});
export type GitHubIssueResponse = z.infer<typeof GitHubIssueResponseSchema>;

export interface GitHubClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  traceSink?: (event: TraceEvent) => unknown;
}

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly traceSink?: (event: TraceEvent) => unknown;

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.token =
      options.token ?? (typeof process !== "undefined" ? process.env.GITHUB_TOKEN : undefined);
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch;
    this.traceSink = options.traceSink;
  }

  private getHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "punch-dependency-triage/1.0",
      ...extra,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Fetches contents of a file or directory from a repository.
   * If the target is a single file and base64 encoded, decodes the text content.
   */
  async getContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<
    HttpResponse<(GitHubFileContent & { decodedContent: string | null }) | GitHubDirectoryContent>
  > {
    const cleanPath = path.replace(/^\//, "");
    let url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath}`;
    if (ref) {
      url += `?ref=${encodeURIComponent(ref)}`;
    }

    const res = await fetchWithRetry({
      url,
      method: "GET",
      headers: this.getHeaders(),
      schema: GitHubContentResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "github_get_contents",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });

    if (Array.isArray(res.data)) {
      return res as HttpResponse<GitHubDirectoryContent>;
    }

    let decoded: string | null = null;
    if (res.data.content) {
      if (res.data.encoding === "base64") {
        const cleaned = res.data.content.replace(/\s/g, "");
        decoded = Buffer.from(cleaned, "base64").toString("utf-8");
      } else {
        decoded = res.data.content;
      }
    }

    const fileWithDecoded = {
      ...res.data,
      decodedContent: decoded,
    };

    return {
      ...res,
      data: fileWithDecoded,
    };
  }

  /**
   * Lists releases for a repository.
   */
  async getReleases(
    owner: string,
    repo: string,
    options: { perPage?: number; page?: number } = {},
    signal?: AbortSignal,
  ): Promise<HttpResponse<GitHubReleasesResponse>> {
    const perPage = options.perPage ?? 30;
    const page = options.page ?? 1;
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${perPage}&page=${page}`;

    return fetchWithRetry({
      url,
      method: "GET",
      headers: this.getHeaders(),
      schema: GitHubReleasesResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "github_get_releases",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });
  }

  /**
   * Compares two commits/tags/branches in a repository.
   */
  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<HttpResponse<GitHubCompareResponse>> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

    return fetchWithRetry({
      url,
      method: "GET",
      headers: this.getHeaders(),
      schema: GitHubCompareResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "github_compare_commits",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });
  }

  /**
   * Creates a new issue in a repository.
   * NOTE: This is an irreversible action and must be gated through approval.
   */
  async createIssue(
    owner: string,
    repo: string,
    issue: {
      title: string;
      body: string;
      labels?: string[];
      assignees?: string[];
    },
    signal?: AbortSignal,
  ): Promise<HttpResponse<GitHubIssueResponse>> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;

    return fetchWithRetry({
      url,
      method: "POST",
      headers: this.getHeaders({ "Content-Type": "application/json" }),
      body: issue,
      schema: GitHubIssueResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "github_create_issue",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });
  }
}
