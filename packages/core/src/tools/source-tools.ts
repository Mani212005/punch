import {
  SourceWorkdir,
  type FetchSourceResult,
  type ReadFileResult,
} from "../analysis/source-fetch.js";
import { analyzeImportGraph, type ImportGraphResult } from "../analysis/import-graph.js";
import { findCallSites, type FindCallSitesResult } from "../analysis/call-sites.js";
import {
  findEntrypointsAndRoutes,
  type FindEntrypointsAndRoutesResult,
} from "../analysis/entrypoints.js";
import { mapTestsForModule, type MapTestsForModuleResult } from "../analysis/test-map.js";
import type { ToolExecutionContext } from "./registry.js";
import { GitHubClient } from "./github.js";

// Global cache of workdirs by runId / path to reuse across tool calls in a run
const workdirCache = new Map<string, SourceWorkdir>();

export function getOrCreateWorkdir(
  workdirPathOrRunId: string,
  context?: ToolExecutionContext,
): SourceWorkdir {
  if (workdirCache.has(workdirPathOrRunId)) {
    return workdirCache.get(workdirPathOrRunId)!;
  }

  const workdir = new SourceWorkdir({
    runId: context?.runId,
    baseDir: workdirPathOrRunId,
    traceSink: context?.traceSink,
  });

  workdirCache.set(workdirPathOrRunId, workdir);
  workdirCache.set(workdir.workdirPath, workdir);
  return workdir;
}

/**
 * Tool: fetch_repo_source
 */
export async function executeFetchRepoSource(
  input: {
    owner?: string;
    repo?: string;
    ref?: string;
    repoUrl?: string;
    localPath?: string;
    maxFiles?: number;
    maxFileSize?: number;
    timeoutMs?: number;
  },
  context: ToolExecutionContext,
): Promise<FetchSourceResult> {
  const workdir = new SourceWorkdir({
    runId: context.runId,
    maxFiles: input.maxFiles,
    maxFileSize: input.maxFileSize,
    timeoutMs: input.timeoutMs,
    traceSink: context.traceSink,
  });

  workdirCache.set(workdir.workdirPath, workdir);
  if (context.runId) {
    workdirCache.set(context.runId, workdir);
  }

  if (input.localPath) {
    return workdir.populateFromLocal(input.localPath, context.signal);
  }

  let owner = input.owner;
  let repo = input.repo;

  if (input.repoUrl && (!owner || !repo)) {
    const match = input.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  }

  if (!owner || !repo) {
    throw new Error(
      "fetch_repo_source requires either 'localPath', or ('owner' and 'repo'), or a valid 'repoUrl'.",
    );
  }

  const ghClient = context.clients?.github ?? new GitHubClient({ traceSink: context.traceSink });
  return workdir.populateFromGitHub({
    owner,
    repo,
    ref: input.ref,
    client: ghClient,
    signal: context.signal,
  });
}

/**
 * Tool: read_repo_file
 */
export async function executeReadRepoFile(
  input: {
    workdir: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    maxBytes?: number;
  },
  context: ToolExecutionContext,
): Promise<ReadFileResult> {
  const workdir = getOrCreateWorkdir(input.workdir, context);
  return workdir.readFile(input.filePath, {
    startLine: input.startLine,
    endLine: input.endLine,
    maxBytes: input.maxBytes,
  });
}

/**
 * Tool: analyze_import_graph
 */
export async function executeAnalyzeImportGraph(
  input: {
    workdir: string;
    targetPackages?: string[];
    targetPackage?: string;
    maxFiles?: number;
    timeoutMs?: number;
  },
  context: ToolExecutionContext,
): Promise<ImportGraphResult> {
  const workdir = getOrCreateWorkdir(input.workdir, context);
  const targetPackages =
    input.targetPackages ?? (input.targetPackage ? [input.targetPackage] : undefined);

  return analyzeImportGraph({
    workdir,
    targetPackages,
    maxFiles: input.maxFiles,
    timeoutMs: input.timeoutMs,
    signal: context.signal,
  });
}

/**
 * Tool: find_call_sites
 */
export async function executeFindCallSites(
  input: {
    workdir: string;
    package?: string;
    targetPackage?: string;
    symbols?: string[];
    maxResults?: number;
    timeoutMs?: number;
  },
  context: ToolExecutionContext,
): Promise<FindCallSitesResult> {
  const workdir = getOrCreateWorkdir(input.workdir, context);
  const targetPackage = input.package ?? input.targetPackage;
  if (!targetPackage) {
    throw new Error("find_call_sites requires 'package' (or 'targetPackage').");
  }

  return findCallSites({
    workdir,
    targetPackage,
    symbols: input.symbols ?? ["*"],
    maxResults: input.maxResults,
    timeoutMs: input.timeoutMs,
    signal: context.signal,
  });
}

/**
 * Tool: find_entrypoints_and_routes
 */
export async function executeFindEntrypointsAndRoutes(
  input: {
    workdir: string;
    targetPackage?: string;
    targetSymbols?: string[];
    timeoutMs?: number;
  },
  context: ToolExecutionContext,
): Promise<FindEntrypointsAndRoutesResult> {
  const workdir = getOrCreateWorkdir(input.workdir, context);
  return findEntrypointsAndRoutes({
    workdir,
    targetPackage: input.targetPackage,
    targetSymbols: input.targetSymbols,
    timeoutMs: input.timeoutMs,
    signal: context.signal,
  });
}

/**
 * Tool: map_tests_for_module
 */
export async function executeMapTestsForModule(
  input: {
    workdir: string;
    targetModule?: string;
    targetPackage?: string;
    targetSymbols?: string[];
    timeoutMs?: number;
  },
  context: ToolExecutionContext,
): Promise<MapTestsForModuleResult> {
  const workdir = getOrCreateWorkdir(input.workdir, context);
  return mapTestsForModule({
    workdir,
    targetModule: input.targetModule,
    targetPackage: input.targetPackage,
    targetSymbols: input.targetSymbols,
    timeoutMs: input.timeoutMs,
    signal: context.signal,
  });
}
