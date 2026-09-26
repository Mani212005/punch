import { describe, it, expect, vi } from "vitest";
import {
  queryVulnerabilitiesWithFallback,
  getReleaseNotesWithFallback,
  getPackageMetadataWithFallback,
  type ToolExecutionContext,
} from "./registry.js";
import { OSVClient } from "./osv.js";
import { GitHubAdvisoryClient } from "./gh-advisory.js";
import { GitHubClient } from "./github.js";
import { NpmClient } from "./npm.js";
import type { TraceEvent } from "@punch/shared";

describe("Tool Fallback Chains", () => {
  describe("OSV -> GitHub Advisory Fallback Chain", () => {
    it("uses primary OSV client when OSV succeeds", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockOsvFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ vulns: [{ id: "GHSA-osv-primary" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const osvClient = new OSVClient({ fetch: mockOsvFetch });
      const context: ToolExecutionContext = {
        clients: { osv: osvClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await queryVulnerabilitiesWithFallback(
        { package: "qs", version: "6.5.2" },
        context,
      );

      expect(result.status).toBe("ok");
      expect(result.source).toBe("osv");
      expect(result.vulnerabilities).toHaveLength(1);
      expect(traceEvents.filter((e) => e.kind === "fallback.used")).toHaveLength(0);
    });

    it("falls back to GitHub Advisory and traces fallback.used when OSV returns 500 error", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockOsvFetch = vi
        .fn()
        .mockResolvedValue(new Response("OSV 500 Internal Server Error", { status: 500 }));
      const mockAdvisoryFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              securityVulnerabilities: {
                nodes: [
                  {
                    advisory: {
                      ghsaId: "GHSA-fallback-advisory",
                      summary: "Prototype pollution",
                      severity: "HIGH",
                      publishedAt: "2022-12-07T00:00:00Z",
                    },
                    vulnerableVersionRange: "< 6.7.3",
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const osvClient = new OSVClient({ fetch: mockOsvFetch, maxRetries: 0 });
      const advisoryClient = new GitHubAdvisoryClient({ fetch: mockAdvisoryFetch });
      const context: ToolExecutionContext = {
        clients: { osv: osvClient, advisory: advisoryClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await queryVulnerabilitiesWithFallback(
        { package: "qs", version: "6.5.2" },
        context,
      );

      expect(result.status).toBe("ok");
      expect(result.source).toBe("github_advisory");
      expect(result.vulnerabilities).toHaveLength(1);

      const fallbackEvents = traceEvents.filter((e) => e.kind === "fallback.used");
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0]?.tool).toBe("query_vulnerabilities");
      expect(fallbackEvents[0]?.from).toBe("osv");
      expect(fallbackEvents[0]?.to).toBe("github_advisory");
    });

    it("degrades gracefully with status: 'degraded' when both OSV and Advisory fail", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockOsvFetch = vi.fn().mockResolvedValue(new Response("OSV down", { status: 503 }));
      const mockAdvisoryFetch = vi
        .fn()
        .mockResolvedValue(new Response("Advisory down", { status: 503 }));

      const osvClient = new OSVClient({ fetch: mockOsvFetch, maxRetries: 0 });
      const advisoryClient = new GitHubAdvisoryClient({ fetch: mockAdvisoryFetch, maxRetries: 0 });
      const context: ToolExecutionContext = {
        clients: { osv: osvClient, advisory: advisoryClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await queryVulnerabilitiesWithFallback(
        { package: "qs", version: "6.5.2" },
        context,
      );

      expect(result.status).toBe("degraded");
      expect(result.vulnerabilities).toEqual([]);

      const fallbackEvents = traceEvents.filter((e) => e.kind === "fallback.used");
      expect(fallbackEvents.length).toBeGreaterThanOrEqual(2);
      expect(fallbackEvents[1]?.to).toBe("degraded");
    });
  });

  describe("Releases -> CHANGELOG.md -> None Fallback Chain", () => {
    it("uses Releases API when releases are present", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockGhFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "4.18.2",
              name: "4.18.2",
              body: "Release notes for 4.18.2",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const ghClient = new GitHubClient({ fetch: mockGhFetch });
      const context: ToolExecutionContext = {
        clients: { github: ghClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await getReleaseNotesWithFallback(
        { owner: "expressjs", repo: "express", targetVersion: "4.18.2" },
        context,
      );

      expect(result.status).toBe("ok");
      expect(result.source).toBe("releases");
      expect(result.notes).toContain("Release notes for 4.18.2");
      expect(traceEvents.filter((e) => e.kind === "fallback.used")).toHaveLength(0);
    });

    it("falls back to CHANGELOG.md and traces fallback.used when releases are empty or 404", async () => {
      const traceEvents: TraceEvent[] = [];
      const changelogBase64 = Buffer.from("# Changelog\n\n## 4.18.2\n- Security patch").toString(
        "base64",
      );

      const mockGhFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/releases")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("/contents/CHANGELOG.md") || url.includes("/contents/History.md")) {
          return new Response(
            JSON.stringify({
              name: "CHANGELOG.md",
              path: "CHANGELOG.md",
              sha: "abc",
              size: 100,
              type: "file",
              content: changelogBase64,
              encoding: "base64",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      });

      const ghClient = new GitHubClient({ fetch: mockGhFetch });
      const context: ToolExecutionContext = {
        clients: { github: ghClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await getReleaseNotesWithFallback(
        { owner: "expressjs", repo: "express", targetVersion: "4.18.2" },
        context,
      );

      expect(result.status).toBe("ok");
      expect(result.source).toBe("changelog");
      expect(result.notes).toContain("Security patch");

      const fallbackEvents = traceEvents.filter((e) => e.kind === "fallback.used");
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0]?.from).toBe("github_releases");
      expect(fallbackEvents[0]?.to).toBe("changelog");
    });

    it("falls back to none with status: 'degraded' when neither releases nor changelog exist", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockGhFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

      const ghClient = new GitHubClient({ fetch: mockGhFetch, maxRetries: 0 });
      const context: ToolExecutionContext = {
        clients: { github: ghClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await getReleaseNotesWithFallback(
        { owner: "expressjs", repo: "express" },
        context,
      );

      expect(result.status).toBe("degraded");
      expect(result.source).toBe("none");
      expect(result.found).toBe(false);
      expect(result.notes).toBeNull();

      const fallbackEvents = traceEvents.filter((e) => e.kind === "fallback.used");
      expect(fallbackEvents.length).toBeGreaterThanOrEqual(2);
      expect(fallbackEvents[1]?.to).toBe("none");
    });
  });

  describe("npm -> unknown Fallback Chain", () => {
    it("falls back to unknown with status: 'degraded' when npm registry returns 404 or error", async () => {
      const traceEvents: TraceEvent[] = [];
      const mockNpmFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

      const npmClient = new NpmClient({ fetch: mockNpmFetch, maxRetries: 0 });
      const context: ToolExecutionContext = {
        clients: { npm: npmClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await getPackageMetadataWithFallback(
        { package: "nonexistent-private-pkg" },
        context,
      );

      expect(result.status).toBe("degraded");
      expect(result.package).toBe("nonexistent-private-pkg");

      const fallbackEvents = traceEvents.filter((e) => e.kind === "fallback.used");
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0]?.from).toBe("npm");
      expect(fallbackEvents[0]?.to).toBe("unknown");
    });
  });
});
