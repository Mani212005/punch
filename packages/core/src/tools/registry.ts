import type { ToolSpec, SlotRole, ErrorClass, TraceEvent } from "@punch/shared";
import { type ApprovalGate, AutoApprovalGate } from "../approval.js";
import { type ToolCache } from "./cache.js";
import { applyToolChaos, type ChaosConfig, type ToolChaosMode } from "./chaos.js";
import { GitHubClient } from "./github.js";
import { OSVClient } from "./osv.js";
import { NpmClient } from "./npm.js";
import { GitHubAdvisoryClient } from "./gh-advisory.js";
import { buildDependencyInventory } from "./inventory.js";
import { HttpError } from "./http.js";
import { CompensationRegistry } from "../remediation/compensation.js";
import { openFixPr } from "../remediation/github-pr.js";
import { isAllowedManifestFile } from "../remediation/proposal.js";
import {
  executeFetchRepoSource,
  executeReadRepoFile,
  executeAnalyzeImportGraph,
  executeFindCallSites,
  executeFindEntrypointsAndRoutes,
  executeMapTestsForModule,
} from "./source-tools.js";

export interface ToolExecutionContext {
  runId?: string;
  seq?: number;
  callId?: string;
  role?: SlotRole;
  agentId?: string;
  subtaskId?: string;
  cache?: ToolCache;
  chaos?: ChaosConfig | Map<string, ToolChaosMode>;
  approvalGate?: ApprovalGate;
  traceSink?: (event: TraceEvent) => unknown;
  signal?: AbortSignal;
  clients?: {
    github?: GitHubClient;
    osv?: OSVClient;
    npm?: NpmClient;
    advisory?: GitHubAdvisoryClient;
  };
}

export interface ToolExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  cached: boolean;
  latencyMs: number;
  retries: number;
  error?: string;
  errorClass?: ErrorClass;
  callId: string;
  status?: "ok" | "degraded" | "unknown" | "denied";
}

// Tool specifications matching ToolSpec in @punch/shared
export const TOOL_SPECS: Record<string, ToolSpec> = {
  github_get_contents: {
    name: "github_get_contents",
    description: "Fetch contents of a file or directory from a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner (user or organization)" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "Path to file or directory within repository" },
        ref: { type: "string", description: "Git commit SHA, branch, or tag" },
      },
      required: ["owner", "repo", "path"],
    },
    irreversible: false,
  },
  github_get_releases: {
    name: "github_get_releases",
    description: "List published releases and release notes for a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        perPage: { type: "number", description: "Releases per page" },
        page: { type: "number", description: "Page number" },
      },
      required: ["owner", "repo"],
    },
    irreversible: false,
  },
  github_compare_commits: {
    name: "github_compare_commits",
    description: "Compare two commits, tags, or branches in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        base: { type: "string", description: "Base commit/tag" },
        head: { type: "string", description: "Head commit/tag" },
      },
      required: ["owner", "repo", "base", "head"],
    },
    irreversible: false,
  },
  github_create_issue: {
    name: "github_create_issue",
    description:
      "Create an issue in a GitHub repository. Irreversible action requiring human approval.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (markdown)" },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Optional assignees",
        },
      },
      required: ["owner", "repo", "title", "body"],
    },
    irreversible: true,
  },
  github_open_fix_pr: {
    name: "github_open_fix_pr",
    description:
      "Open a fix PR on a new branch with exactly the validated manifest/lockfile changes. Irreversible action requiring human approval. Only use for a PASS sandbox validation.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        base: { type: "string", description: "Base branch, e.g. main" },
        branch: { type: "string", description: "Fix branch to create" },
        title: { type: "string", description: "PR title" },
        body: {
          type: "string",
          description:
            "PR body carrying the finding, evidence, validation summary and critic verdict",
        },
        files: {
          type: "object",
          description: "Exactly the validated manifest/lockfile diff: path to full file content",
        },
      },
      required: ["owner", "repo", "branch", "title", "body", "files"],
    },
    irreversible: true,
  },
  osv_query: {
    name: "osv_query",
    description: "Query the OSV database for vulnerabilities affecting a package and version.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "object",
          properties: {
            name: { type: "string" },
            ecosystem: { type: "string" },
          },
          required: ["name"],
        },
        version: { type: "string" },
        commit: { type: "string" },
      },
      required: ["package"],
    },
    irreversible: false,
  },
  osv_query_batch: {
    name: "osv_query_batch",
    description: "Batch query the OSV database for vulnerabilities across multiple packages.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              package: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  ecosystem: { type: "string" },
                },
                required: ["name"],
              },
              version: { type: "string" },
            },
            required: ["package"],
          },
        },
      },
      required: ["queries"],
    },
    irreversible: false,
  },
  npm_package_metadata: {
    name: "npm_package_metadata",
    description: "Fetch metadata and published versions for an npm package.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "npm package name (e.g. express, @punch/shared)" },
      },
      required: ["package"],
    },
    irreversible: false,
  },
  github_advisory_graphql: {
    name: "github_advisory_graphql",
    description: "Query the GitHub Advisory database via GraphQL for security advisories.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: { type: "string", description: "Package ecosystem, default NPM" },
      },
      required: ["package"],
    },
    irreversible: false,
  },
  query_vulnerabilities: {
    name: "query_vulnerabilities",
    description: "Query vulnerabilities with automatic OSV -> GitHub Advisory fallback chain.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
        ecosystem: { type: "string", description: "Ecosystem (default: npm)" },
        version: { type: "string", description: "Package version" },
      },
      required: ["package"],
    },
    irreversible: false,
  },
  get_release_notes: {
    name: "get_release_notes",
    description:
      "Fetch release notes with automatic GitHub Releases -> CHANGELOG.md -> none fallback chain.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        targetVersion: { type: "string", description: "Target version/tag" },
        fromVersion: { type: "string", description: "Current/from version" },
      },
      required: ["owner", "repo"],
    },
    irreversible: false,
  },
  get_package_metadata: {
    name: "get_package_metadata",
    description: "Fetch package info with automatic npm -> unknown fallback chain.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name" },
      },
      required: ["package"],
    },
    irreversible: false,
  },
  parse_dependency_inventory: {
    name: "parse_dependency_inventory",
    description: "Parse package.json and lockfile content into a structured dependency inventory.",
    inputSchema: {
      type: "object",
      properties: {
        packageJson: { type: "string", description: "Contents of package.json" },
        packageLock: { type: "string", description: "Optional contents of package-lock.json" },
        pnpmLock: { type: "string", description: "Optional contents of pnpm-lock.yaml" },
      },
      required: ["packageJson"],
    },
    irreversible: false,
  },
  fetch_repo_source: {
    name: "fetch_repo_source",
    description: "Fetch repository source from GitHub or local directory into a read-only workdir.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub repository owner" },
        repo: { type: "string", description: "GitHub repository name" },
        ref: { type: "string", description: "Git commit SHA, branch, or tag" },
        repoUrl: { type: "string", description: "Full GitHub repository URL" },
        localPath: {
          type: "string",
          description: "Local directory path for offline/test execution",
        },
        maxFiles: { type: "number", description: "Maximum number of files to fetch" },
        maxFileSize: { type: "number", description: "Maximum size per file in bytes" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
      },
    },
    irreversible: false,
  },
  read_repo_file: {
    name: "read_repo_file",
    description:
      "Read a source file from the repository workdir with line span and evidence generation.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        filePath: { type: "string", description: "Relative path to file in workdir" },
        startLine: { type: "number", description: "1-based starting line number" },
        endLine: { type: "number", description: "1-based ending line number" },
        maxBytes: { type: "number", description: "Maximum bytes to read" },
      },
      required: ["workdir", "filePath"],
    },
    irreversible: false,
  },
  static_read_file: {
    name: "static_read_file",
    description: "Alias for read_repo_file: read a source file from the repository workdir.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        filePath: { type: "string", description: "Relative path to file in workdir" },
        startLine: { type: "number", description: "1-based starting line number" },
        endLine: { type: "number", description: "1-based ending line number" },
      },
      required: ["workdir", "filePath"],
    },
    irreversible: false,
  },
  analyze_import_graph: {
    name: "analyze_import_graph",
    description:
      "Build TypeScript/JavaScript AST import and export graph across all repository source files.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetPackages: {
          type: "array",
          items: { type: "string" },
          description: "Optional package names to check usage and prove absence for",
        },
        targetPackage: { type: "string", description: "Single package name to check" },
        maxFiles: { type: "number", description: "Maximum files to analyze" },
        timeoutMs: { type: "number", description: "Analysis timeout in milliseconds" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  static_import_graph: {
    name: "static_import_graph",
    description:
      "Alias for analyze_import_graph: build import and export graph across repository source files.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetPackages: {
          type: "array",
          items: { type: "string" },
          description: "Optional package names to check usage and prove absence for",
        },
        targetPackage: { type: "string", description: "Single package name to check" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  find_call_sites: {
    name: "find_call_sites",
    description:
      "Search for call sites and member accesses of affected symbols belonging to a package.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        package: { type: "string", description: "Target package name (e.g. qs, lodash)" },
        targetPackage: { type: "string", description: "Alternative package name parameter" },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "List of affected symbol names (e.g. ['parse', 'merge'])",
        },
        maxResults: { type: "number", description: "Maximum call sites to return" },
        timeoutMs: { type: "number", description: "Search timeout in milliseconds" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  static_call_sites: {
    name: "static_call_sites",
    description: "Alias for find_call_sites: search for call sites and usages of affected symbols.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        package: { type: "string", description: "Target package name" },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "List of symbol names",
        },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  find_entrypoints_and_routes: {
    name: "find_entrypoints_and_routes",
    description:
      "Identify application entrypoints and HTTP routes (Express, Fastify, Next.js, Hono).",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetPackage: {
          type: "string",
          description: "Optional package to test reachability from routes",
        },
        targetSymbols: {
          type: "array",
          items: { type: "string" },
          description: "Optional symbol names to test reachability from routes",
        },
        timeoutMs: { type: "number", description: "Discovery timeout in milliseconds" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  static_entrypoints: {
    name: "static_entrypoints",
    description: "Alias for find_entrypoints_and_routes: list entrypoints and HTTP routes.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetPackage: { type: "string", description: "Optional package name" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  map_tests_for_module: {
    name: "map_tests_for_module",
    description: "Map test files in the repository to target modules, packages, and symbols.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetModule: {
          type: "string",
          description: "Target module relative path (e.g. src/parser.ts)",
        },
        targetPackage: { type: "string", description: "Target package name (e.g. qs)" },
        targetSymbols: {
          type: "array",
          items: { type: "string" },
          description: "Target symbol names to test coverage for",
        },
        timeoutMs: { type: "number", description: "Mapping timeout in milliseconds" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
  static_test_map: {
    name: "static_test_map",
    description: "Alias for map_tests_for_module: map test files covering a module or package.",
    inputSchema: {
      type: "object",
      properties: {
        workdir: { type: "string", description: "Path to repository workdir" },
        targetModule: { type: "string", description: "Target module relative path" },
        targetPackage: { type: "string", description: "Target package name" },
      },
      required: ["workdir"],
    },
    irreversible: false,
  },
};

/**
 * Returns all tool specs as an array.
 */
export function getToolSpecs(): ToolSpec[] {
  return Object.values(TOOL_SPECS);
}

/**
 * Helper to emit a trace event safely.
 */
async function emitTrace(
  traceSink: ((event: TraceEvent) => unknown) | undefined,
  event: TraceEvent,
) {
  if (!traceSink) return;
  try {
    await traceSink(event);
  } catch {
    // Ignore trace sink errors
  }
}

/**
 * Executes fallback chain 1: OSV -> GitHub Advisory -> degraded
 */
export async function queryVulnerabilitiesWithFallback(
  input: { package: string; ecosystem?: string; version?: string },
  context: ToolExecutionContext,
): Promise<{ vulnerabilities: unknown[]; status: "ok" | "degraded"; source: string }> {
  const osvClient = context.clients?.osv ?? new OSVClient({ traceSink: context.traceSink });
  const advisoryClient =
    context.clients?.advisory ?? new GitHubAdvisoryClient({ traceSink: context.traceSink });

  // 1. Try OSV
  try {
    const osvRes = await osvClient.query(
      {
        package: {
          name: input.package,
          ecosystem: input.ecosystem ?? "npm",
        },
        version: input.version,
      },
      context.signal,
    );

    return {
      vulnerabilities: osvRes.data.vulns ?? [],
      status: "ok",
      source: "osv",
    };
  } catch (osvErr) {
    const reason = osvErr instanceof Error ? osvErr.message : String(osvErr);

    // Emit fallback.used event
    await emitTrace(context.traceSink, {
      runId: context.runId ?? "run",
      seq: context.seq ?? 0,
      ts: Date.now(),
      kind: "fallback.used",
      tool: "query_vulnerabilities",
      from: "osv",
      to: "github_advisory",
      reason,
    });

    // 2. Try GitHub Advisory
    try {
      const advRes = await advisoryClient.queryAdvisories(
        input.package,
        input.ecosystem ?? "NPM",
        context.signal,
      );

      return {
        vulnerabilities: advRes.data.advisories ?? [],
        status: "ok",
        source: "github_advisory",
      };
    } catch (advErr) {
      const advReason = advErr instanceof Error ? advErr.message : String(advErr);

      // Both failed, degrade
      await emitTrace(context.traceSink, {
        runId: context.runId ?? "run",
        seq: context.seq ?? 0,
        ts: Date.now(),
        kind: "fallback.used",
        tool: "query_vulnerabilities",
        from: "github_advisory",
        to: "degraded",
        reason: advReason,
      });

      return {
        vulnerabilities: [],
        status: "degraded",
        source: "none",
      };
    }
  }
}

/**
 * Executes fallback chain 2: releases -> CHANGELOG.md -> none
 */
export async function getReleaseNotesWithFallback(
  input: { owner: string; repo: string; targetVersion?: string; fromVersion?: string },
  context: ToolExecutionContext,
): Promise<{
  found: boolean;
  notes: string | null;
  source: "releases" | "changelog" | "none";
  status: "ok" | "degraded";
}> {
  const ghClient = context.clients?.github ?? new GitHubClient({ traceSink: context.traceSink });

  // 1. Try GitHub Releases API
  let releasesFailed = false;
  let releasesError = "";

  try {
    const releasesRes = await ghClient.getReleases(
      input.owner,
      input.repo,
      { perPage: 30 },
      context.signal,
    );

    const releases = releasesRes.data;
    if (releases.length > 0) {
      // Find matching release for targetVersion if specified
      if (input.targetVersion) {
        const targetClean = input.targetVersion.replace(/^v/, "");
        const match = releases.find(
          (r) =>
            r.tag_name.replace(/^v/, "") === targetClean ||
            r.name?.replace(/^v/, "").includes(targetClean),
        );
        if (match && match.body) {
          return {
            found: true,
            notes: match.body,
            source: "releases",
            status: "ok",
          };
        }
      } else {
        // Return latest release notes
        const latest = releases[0];
        if (latest?.body) {
          return {
            found: true,
            notes: latest.body,
            source: "releases",
            status: "ok",
          };
        }
      }
    }
    // If no release found or body is empty, trigger fallback
    releasesFailed = true;
    releasesError = "No matching release notes found in releases API";
  } catch (err) {
    releasesFailed = true;
    releasesError = err instanceof Error ? err.message : String(err);
  }

  if (releasesFailed) {
    await emitTrace(context.traceSink, {
      runId: context.runId ?? "run",
      seq: context.seq ?? 0,
      ts: Date.now(),
      kind: "fallback.used",
      tool: "get_release_notes",
      from: "github_releases",
      to: "changelog",
      reason: releasesError,
    });

    // 2. Try CHANGELOG.md via GitHub Contents API
    const changelogCandidates = [
      "CHANGELOG.md",
      "changelog.md",
      "HISTORY.md",
      "History.md",
      "CHANGES.md",
    ];

    for (const filename of changelogCandidates) {
      try {
        const contentsRes = await ghClient.getContents(
          input.owner,
          input.repo,
          filename,
          undefined,
          context.signal,
        );

        if (!Array.isArray(contentsRes.data) && contentsRes.data.decodedContent) {
          return {
            found: true,
            notes: contentsRes.data.decodedContent,
            source: "changelog",
            status: "ok",
          };
        }
      } catch {
        // Try next candidate
      }
    }

    // 3. Fallback to none -> degraded
    await emitTrace(context.traceSink, {
      runId: context.runId ?? "run",
      seq: context.seq ?? 0,
      ts: Date.now(),
      kind: "fallback.used",
      tool: "get_release_notes",
      from: "changelog",
      to: "none",
      reason: "No changelog or release notes file found",
    });

    return {
      found: false,
      notes: null,
      source: "none",
      status: "degraded",
    };
  }

  return {
    found: false,
    notes: null,
    source: "none",
    status: "degraded",
  };
}

/**
 * Executes fallback chain 3: npm -> unknown/degraded
 */
export async function getPackageMetadataWithFallback(
  input: { package: string },
  context: ToolExecutionContext,
): Promise<{
  package: string;
  metadata?: unknown;
  status: "ok" | "unknown" | "degraded";
}> {
  const npmClient = context.clients?.npm ?? new NpmClient({ traceSink: context.traceSink });

  try {
    const res = await npmClient.getPackageMetadata(input.package, context.signal);
    return {
      package: input.package,
      metadata: res.data,
      status: "ok",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    await emitTrace(context.traceSink, {
      runId: context.runId ?? "run",
      seq: context.seq ?? 0,
      ts: Date.now(),
      kind: "fallback.used",
      tool: "get_package_metadata",
      from: "npm",
      to: "unknown",
      reason,
    });

    return {
      package: input.package,
      metadata: undefined,
      status: "degraded",
    };
  }
}

/**
 * Universal tool dispatcher.
 * Handles cache check/hit, chaos injection, approval gate for irreversible tools,
 * tool execution, cache storage, and trace events.
 */
export async function executeTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext = {},
): Promise<ToolExecutionResult<T>> {
  const runId = context.runId ?? "run";
  const seq = context.seq ?? 0;
  const callId = context.callId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const role: SlotRole = context.role ?? "researcher";
  const agentId = context.agentId ?? "agent";
  const subtaskId = context.subtaskId;

  const toolSpec = TOOL_SPECS[toolName];
  if (!toolSpec) {
    throw new Error(`Tool '${toolName}' is not registered in TOOL_SPECS.`);
  }

  // 1. Emit tool.called event
  await emitTrace(context.traceSink, {
    runId,
    seq,
    ts: Date.now(),
    kind: "tool.called",
    role,
    agentId,
    subtaskId,
    callId,
    tool: toolName,
    input,
  });

  // 2. Check cache
  if (context.cache) {
    const cached = context.cache.get<T>(toolName, input);
    if (cached.hit) {
      await emitTrace(context.traceSink, {
        runId,
        seq,
        ts: Date.now(),
        kind: "tool.result",
        callId,
        tool: toolName,
        ok: true,
        cached: true,
        latencyMs: 0,
        retries: 0,
        output: cached.output,
      });

      return {
        ok: true,
        cached: true,
        output: cached.output,
        latencyMs: 0,
        retries: 0,
        callId,
        status: "ok",
      };
    }
  }

  // 3. Check chaos injection
  if (context.chaos) {
    const chaosResult = await applyToolChaos(toolName, context.chaos, context.signal);
    if (chaosResult.intercepted) {
      if (context.cache) {
        context.cache.set(toolName, input, chaosResult.output);
      }
      return {
        ok: true,
        cached: false,
        output: chaosResult.output as T,
        latencyMs: 1,
        retries: 0,
        callId,
        status: "ok",
      };
    }
  }

  // 4. Check approval for irreversible tools
  if (toolSpec.irreversible) {
    const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const approvalGate = context.approvalGate ?? new AutoApprovalGate();

    await emitTrace(context.traceSink, {
      runId,
      seq,
      ts: Date.now(),
      kind: "approval.requested",
      approvalId,
      tool: toolName,
      payload: input,
    });

    const decision = await approvalGate.requestApproval({
      approvalId,
      tool: toolName,
      payload: input,
      subtaskId,
      agentId,
    });

    if (!decision.approved) {
      await emitTrace(context.traceSink, {
        runId,
        seq,
        ts: Date.now(),
        kind: "approval.denied",
        approvalId,
        decidedBy: decision.decidedBy,
        reason: decision.reason,
      });

      await emitTrace(context.traceSink, {
        runId,
        seq,
        ts: Date.now(),
        kind: "tool.result",
        callId,
        tool: toolName,
        ok: false,
        cached: false,
        latencyMs: 0,
        retries: 0,
        error: decision.reason ?? "Approval denied",
        errorClass: "permanent",
      });

      return {
        ok: false,
        cached: false,
        error: decision.reason ?? "Approval denied",
        errorClass: "permanent",
        latencyMs: 0,
        retries: 0,
        callId,
        status: "denied",
      };
    }

    await emitTrace(context.traceSink, {
      runId,
      seq,
      ts: Date.now(),
      kind: "approval.granted",
      approvalId,
      decidedBy: decision.decidedBy,
    });
  }

  // 5. Execute tool logic
  const startTime = Date.now();
  let output: unknown;
  let retries = 0;
  let executionError: unknown;

  try {
    const ghClient = context.clients?.github ?? new GitHubClient({ traceSink: context.traceSink });
    const osvClient = context.clients?.osv ?? new OSVClient({ traceSink: context.traceSink });
    const npmClient = context.clients?.npm ?? new NpmClient({ traceSink: context.traceSink });
    const advClient =
      context.clients?.advisory ?? new GitHubAdvisoryClient({ traceSink: context.traceSink });

    switch (toolName) {
      case "github_get_contents": {
        const res = await ghClient.getContents(
          input.owner as string,
          input.repo as string,
          input.path as string,
          input.ref as string | undefined,
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "github_get_releases": {
        const res = await ghClient.getReleases(
          input.owner as string,
          input.repo as string,
          {
            perPage: input.perPage as number | undefined,
            page: input.page as number | undefined,
          },
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "github_compare_commits": {
        const res = await ghClient.compareCommits(
          input.owner as string,
          input.repo as string,
          input.base as string,
          input.head as string,
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "github_create_issue": {
        const res = await ghClient.createIssue(
          input.owner as string,
          input.repo as string,
          {
            title: input.title as string,
            body: input.body as string,
            labels: input.labels as string[] | undefined,
            assignees: input.assignees as string[] | undefined,
          },
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "github_open_fix_pr": {
        const files = (input.files ?? {}) as Record<string, string>;
        const allowed = Object.fromEntries(
          Object.entries(files).filter(
            ([path, content]) => typeof content === "string" && isAllowedManifestFile(path),
          ),
        );
        if (Object.keys(allowed).length === 0) {
          throw new Error(
            "refusing to open a fix PR with no validated manifest or lockfile changes",
          );
        }
        const registry = new CompensationRegistry(
          context.traceSink ? { write: context.traceSink } : undefined,
          runId,
          seq,
        );
        const result = await openFixPr(
          ghClient,
          {
            owner: input.owner as string,
            repo: input.repo as string,
            base: (input.base as string | undefined) ?? "main",
            branch: input.branch as string,
            title: input.title as string,
            body: input.body as string,
            sandbox: {
              isolation: "docker",
              baseline: null,
              candidate: null,
              newFailures: [],
              fixedFailures: [],
              changedFiles: Object.keys(allowed),
              verdict: "PASS",
              evidenceIds: [],
            },
            validatedFiles: allowed,
            signal: context.signal,
          },
          registry,
        );
        output = result.pull;
        break;
      }
      case "osv_query": {
        const pkg = input.package as { name: string; ecosystem?: string };
        const res = await osvClient.query(
          {
            package: pkg,
            version: input.version as string | undefined,
            commit: input.commit as string | undefined,
          },
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "osv_query_batch": {
        const queries = input.queries as Array<{
          package: { name: string; ecosystem?: string };
          version?: string;
        }>;
        const res = await osvClient.queryBatch(queries, context.signal);
        output = res.data;
        retries = res.retries;
        break;
      }
      case "npm_package_metadata": {
        const res = await npmClient.getPackageMetadata(input.package as string, context.signal);
        output = res.data;
        retries = res.retries;
        break;
      }
      case "github_advisory_graphql": {
        const res = await advClient.queryAdvisories(
          input.package as string,
          input.ecosystem as string | undefined,
          context.signal,
        );
        output = res.data;
        retries = res.retries;
        break;
      }
      case "query_vulnerabilities": {
        output = await queryVulnerabilitiesWithFallback(
          {
            package: input.package as string,
            ecosystem: input.ecosystem as string | undefined,
            version: input.version as string | undefined,
          },
          context,
        );
        break;
      }
      case "get_release_notes": {
        output = await getReleaseNotesWithFallback(
          {
            owner: input.owner as string,
            repo: input.repo as string,
            targetVersion: input.targetVersion as string | undefined,
            fromVersion: input.fromVersion as string | undefined,
          },
          context,
        );
        break;
      }
      case "get_package_metadata": {
        output = await getPackageMetadataWithFallback(
          { package: input.package as string },
          context,
        );
        break;
      }
      case "parse_dependency_inventory": {
        output = buildDependencyInventory({
          packageJson: input.packageJson as string,
          packageLock: input.packageLock as string | undefined,
          pnpmLock: input.pnpmLock as string | undefined,
        });
        break;
      }
      case "fetch_repo_source": {
        output = await executeFetchRepoSource(
          {
            owner: input.owner as string | undefined,
            repo: input.repo as string | undefined,
            ref: input.ref as string | undefined,
            repoUrl: input.repoUrl as string | undefined,
            localPath: input.localPath as string | undefined,
            maxFiles: input.maxFiles as number | undefined,
            maxFileSize: input.maxFileSize as number | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          },
          context,
        );
        break;
      }
      case "read_repo_file":
      case "static_read_file": {
        output = await executeReadRepoFile(
          {
            workdir: input.workdir as string,
            filePath: input.filePath as string,
            startLine: input.startLine as number | undefined,
            endLine: input.endLine as number | undefined,
            maxBytes: input.maxBytes as number | undefined,
          },
          context,
        );
        break;
      }
      case "analyze_import_graph":
      case "static_import_graph": {
        output = await executeAnalyzeImportGraph(
          {
            workdir: input.workdir as string,
            targetPackages: input.targetPackages as string[] | undefined,
            targetPackage: input.targetPackage as string | undefined,
            maxFiles: input.maxFiles as number | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          },
          context,
        );
        break;
      }
      case "find_call_sites":
      case "static_call_sites": {
        output = await executeFindCallSites(
          {
            workdir: input.workdir as string,
            package: input.package as string | undefined,
            targetPackage: input.targetPackage as string | undefined,
            symbols: input.symbols as string[] | undefined,
            maxResults: input.maxResults as number | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          },
          context,
        );
        break;
      }
      case "find_entrypoints_and_routes":
      case "static_entrypoints": {
        output = await executeFindEntrypointsAndRoutes(
          {
            workdir: input.workdir as string,
            targetPackage: input.targetPackage as string | undefined,
            targetSymbols: input.targetSymbols as string[] | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          },
          context,
        );
        break;
      }
      case "map_tests_for_module":
      case "static_test_map": {
        output = await executeMapTestsForModule(
          {
            workdir: input.workdir as string,
            targetModule: input.targetModule as string | undefined,
            targetPackage: input.targetPackage as string | undefined,
            targetSymbols: input.targetSymbols as string[] | undefined,
            timeoutMs: input.timeoutMs as number | undefined,
          },
          context,
        );
        break;
      }
      default:
        throw new Error(`Tool '${toolName}' implementation not found.`);
    }
  } catch (err) {
    executionError = err;
  }

  const latencyMs = Date.now() - startTime;

  if (executionError) {
    const errorMsg =
      executionError instanceof Error ? executionError.message : String(executionError);
    let errorClass: ErrorClass = "permanent";
    if (executionError instanceof HttpError) {
      errorClass = executionError.errorClass;
      retries = executionError.retries;
    }

    await emitTrace(context.traceSink, {
      runId,
      seq,
      ts: Date.now(),
      kind: "tool.result",
      callId,
      tool: toolName,
      ok: false,
      cached: false,
      latencyMs,
      retries,
      error: errorMsg,
      errorClass,
    });

    return {
      ok: false,
      cached: false,
      latencyMs,
      retries,
      error: errorMsg,
      errorClass,
      callId,
      status: "degraded",
    };
  }

  // Save to cache on success
  if (context.cache) {
    context.cache.set(toolName, input, output);
  }

  await emitTrace(context.traceSink, {
    runId,
    seq,
    ts: Date.now(),
    kind: "tool.result",
    callId,
    tool: toolName,
    ok: true,
    cached: false,
    latencyMs,
    retries,
    output,
  });

  return {
    ok: true,
    cached: false,
    latencyMs,
    retries,
    output: output as T,
    callId,
    status: "ok",
  };
}
