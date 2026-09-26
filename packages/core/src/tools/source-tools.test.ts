import { describe, it, expect } from "vitest";
import path from "node:path";
import { executeTool } from "./registry.js";
import { ToolCache } from "./cache.js";
import { Blackboard } from "../blackboard.js";
import { ToolLedger, createRoleToolExecutor, toolsForRole } from "../roles/common.js";
import type { TraceEvent } from "@punch/shared";
import type { FetchSourceResult, ReadFileResult } from "../analysis/source-fetch.js";
import type { ImportGraphResult } from "../analysis/import-graph.js";
import type { FindCallSitesResult } from "../analysis/call-sites.js";
import type { FindEntrypointsAndRoutesResult } from "../analysis/entrypoints.js";
import type { MapTestsForModuleResult } from "../analysis/test-map.js";

describe("Source tools and static analysis registry integration", () => {
  const expressFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");

  it("executes fetch_repo_source tool with localPath", async () => {
    const events: TraceEvent[] = [];
    const res = await executeTool<FetchSourceResult>(
      "fetch_repo_source",
      { localPath: expressFixtureDir },
      {
        runId: "run_test_tools",
        traceSink: (e) => events.push(e),
      },
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe("ok");
    expect(res.output?.fileCount).toBeGreaterThan(0);
    expect(res.output?.workdir).toBeDefined();

    // Verify trace events
    expect(events.some((e) => e.kind === "tool.called" && e.tool === "fetch_repo_source")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "tool.result" && e.tool === "fetch_repo_source")).toBe(
      true,
    );
  });

  it("executes read_repo_file and static_read_file alias", async () => {
    const res = await executeTool<ReadFileResult>(
      "read_repo_file",
      {
        workdir: expressFixtureDir,
        filePath: "src/index.ts",
        startLine: 1,
        endLine: 5,
      },
      { runId: "run_test_read" },
    );

    expect(res.ok).toBe(true);
    expect(res.output?.filePath).toBe("src/index.ts");
    expect(res.output?.content).toContain("express");
    expect(res.output?.evidence.kind).toBe("file");

    // Test alias static_read_file
    const aliasRes = await executeTool<ReadFileResult>(
      "static_read_file",
      {
        workdir: expressFixtureDir,
        filePath: "src/index.ts",
      },
      { runId: "run_test_read" },
    );
    expect(aliasRes.ok).toBe(true);
    expect(aliasRes.output?.filePath).toBe("src/index.ts");
  });

  it("executes analyze_import_graph and caches result", async () => {
    const cache = new ToolCache();
    const context = { runId: "run_test_cache", cache };

    const firstCall = await executeTool<ImportGraphResult>(
      "analyze_import_graph",
      {
        workdir: expressFixtureDir,
        targetPackages: ["qs", "unused-lib"],
      },
      context,
    );

    expect(firstCall.ok).toBe(true);
    expect(firstCall.cached).toBe(false);
    expect(firstCall.output?.packageUsage["qs"]?.used).toBe(true);
    expect(firstCall.output?.packageUsage["unused-lib"]?.used).toBe(false);

    // Second call should hit cache
    const secondCall = await executeTool<ImportGraphResult>(
      "analyze_import_graph",
      {
        workdir: expressFixtureDir,
        targetPackages: ["qs", "unused-lib"],
      },
      context,
    );

    expect(secondCall.ok).toBe(true);
    expect(secondCall.cached).toBe(true);
    expect(secondCall.output?.packageUsage["qs"]?.used).toBe(true);
  });

  it("executes find_call_sites and static_call_sites alias", async () => {
    const res = await executeTool<FindCallSitesResult>(
      "find_call_sites",
      {
        workdir: expressFixtureDir,
        package: "qs",
        symbols: ["parse"],
      },
      { runId: "run_test_callsites" },
    );

    expect(res.ok).toBe(true);
    expect(res.output?.found).toBe(true);
    expect(res.output?.callSites.length).toBeGreaterThan(0);
    expect(res.output?.evidence.length).toBeGreaterThan(0);

    // Alias test
    const aliasRes = await executeTool<FindCallSitesResult>(
      "static_call_sites",
      {
        workdir: expressFixtureDir,
        package: "qs",
        symbols: ["parse"],
      },
      { runId: "run_test_callsites" },
    );
    expect(aliasRes.ok).toBe(true);
    expect(aliasRes.output?.found).toBe(true);
  });

  it("executes find_entrypoints_and_routes", async () => {
    const res = await executeTool<FindEntrypointsAndRoutesResult>(
      "find_entrypoints_and_routes",
      {
        workdir: expressFixtureDir,
        targetPackage: "qs",
        targetSymbols: ["parse"],
      },
      { runId: "run_test_routes" },
    );

    expect(res.ok).toBe(true);
    expect(res.output?.routes.length).toBeGreaterThan(0);
    expect(res.output?.entrypoints.length).toBeGreaterThan(0);
  });

  it("executes map_tests_for_module", async () => {
    const res = await executeTool<MapTestsForModuleResult>(
      "map_tests_for_module",
      {
        workdir: expressFixtureDir,
        targetPackage: "qs",
        targetSymbols: ["parse"],
      },
      { runId: "run_test_tests" },
    );

    expect(res.ok).toBe(true);
    expect(res.output?.matchingTestFiles).toContain("tests/api.test.ts");
    expect(res.output?.evidence.length).toBeGreaterThan(0);
  });

  it("verifies reachability role executor has access to all static analysis tools", async () => {
    const reachabilityTools = toolsForRole("reachability");
    const toolNames = reachabilityTools.map((t) => t.name);

    expect(toolNames).toContain("fetch_repo_source");
    expect(toolNames).toContain("read_repo_file");
    expect(toolNames).toContain("analyze_import_graph");
    expect(toolNames).toContain("find_call_sites");
    expect(toolNames).toContain("find_entrypoints_and_routes");
    expect(toolNames).toContain("map_tests_for_module");

    const blackboard = new Blackboard();
    const ledger = new ToolLedger();
    const roleExecutor = createRoleToolExecutor({
      role: "reachability",
      blackboard,
      ledger,
    });

    const output = (await roleExecutor({
      callId: "test_call_reach",
      name: "find_call_sites",
      input: {
        workdir: expressFixtureDir,
        package: "qs",
        symbols: ["parse"],
      },
      signal: new AbortController().signal,
    })) as FindCallSitesResult;

    expect(output.found).toBe(true);
    expect(output.callSites.length).toBeGreaterThan(0);
  });
});
