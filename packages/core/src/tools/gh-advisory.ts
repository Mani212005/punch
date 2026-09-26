import { z } from "zod";
import { fetchWithRetry, type HttpResponse } from "./http.js";
import type { TraceEvent } from "@punch/shared";

export const GitHubAdvisoryVulnerabilityNodeSchema = z.object({
  advisory: z.object({
    ghsaId: z.string(),
    cveId: z.string().nullable().optional(),
    summary: z.string(),
    description: z.string().optional(),
    severity: z.string(),
    publishedAt: z.string().optional(),
    references: z
      .array(
        z.object({
          url: z.string(),
        }),
      )
      .optional()
      .default([]),
  }),
  vulnerableVersionRange: z.string().optional(),
  firstPatchedVersion: z
    .object({
      identifier: z.string(),
    })
    .nullable()
    .optional(),
  package: z
    .object({
      name: z.string().optional(),
      ecosystem: z.string().optional(),
    })
    .optional(),
});
export type GitHubAdvisoryVulnerabilityNode = z.infer<typeof GitHubAdvisoryVulnerabilityNodeSchema>;

export const GitHubAdvisoryGraphQLResponseSchema = z.object({
  data: z
    .object({
      securityVulnerabilities: z
        .object({
          totalCount: z.number().optional(),
          nodes: z.array(GitHubAdvisoryVulnerabilityNodeSchema).default([]),
        })
        .optional(),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional(),
});
export type GitHubAdvisoryGraphQLResponse = z.infer<typeof GitHubAdvisoryGraphQLResponseSchema>;

export interface NormalizedAdvisory {
  id: string;
  ghsaId: string;
  cveId?: string;
  summary: string;
  description?: string;
  severity: string;
  vulnerableVersionRange?: string;
  firstPatchedVersion?: string;
  references: string[];
}

export interface GitHubAdvisoryClientOptions {
  graphqlUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  traceSink?: (event: TraceEvent) => unknown;
}

const GRAPHQL_QUERY = `
query ($ecosystem: SecurityAdvisoryEcosystem!, $package: String!) {
  securityVulnerabilities(first: 50, ecosystem: $ecosystem, package: $package) {
    totalCount
    nodes {
      advisory {
        ghsaId
        cveId
        summary
        description
        severity
        publishedAt
        references {
          url
        }
      }
      vulnerableVersionRange
      firstPatchedVersion {
        identifier
      }
      package {
        name
        ecosystem
      }
    }
  }
}
`;

export class GitHubAdvisoryClient {
  private readonly graphqlUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly traceSink?: (event: TraceEvent) => unknown;

  constructor(options: GitHubAdvisoryClientOptions = {}) {
    this.graphqlUrl = options.graphqlUrl ?? "https://api.github.com/graphql";
    this.token =
      options.token ?? (typeof process !== "undefined" ? process.env.GITHUB_TOKEN : undefined);
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch;
    this.traceSink = options.traceSink;
  }

  /**
   * Queries GitHub Advisory database via GraphQL for security vulnerabilities affecting a package.
   */
  async queryAdvisories(
    packageName: string,
    ecosystem: string = "NPM",
    signal?: AbortSignal,
  ): Promise<HttpResponse<{ advisories: NormalizedAdvisory[] }>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "punch-dependency-triage/1.0",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const payload = {
      query: GRAPHQL_QUERY,
      variables: {
        ecosystem: ecosystem.toUpperCase(),
        package: packageName,
      },
    };

    const res = await fetchWithRetry({
      url: this.graphqlUrl,
      method: "POST",
      headers,
      body: payload,
      schema: GitHubAdvisoryGraphQLResponseSchema,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      signal,
      tool: "github_advisory_graphql",
      fetch: this.fetchImpl,
      traceSink: this.traceSink,
    });

    const nodes = res.data.data?.securityVulnerabilities?.nodes || [];
    const advisories: NormalizedAdvisory[] = nodes.map((node) => ({
      id: node.advisory.ghsaId,
      ghsaId: node.advisory.ghsaId,
      cveId: node.advisory.cveId ?? undefined,
      summary: node.advisory.summary,
      description: node.advisory.description,
      severity: node.advisory.severity,
      vulnerableVersionRange: node.vulnerableVersionRange,
      firstPatchedVersion: node.firstPatchedVersion?.identifier ?? undefined,
      references: (node.advisory.references || []).map((r) => r.url),
    }));

    return {
      ...res,
      data: { advisories },
    };
  }
}
