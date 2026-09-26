import path from "node:path";
import { type EvidenceRecord } from "@punch/shared";
import { SourceWorkdir } from "./source-fetch.js";
import { analyzeImportGraph } from "./import-graph.js";
import { findCallSites, type CallSite } from "./call-sites.js";

export interface TestFileCoverage {
  testFile: string;
  importsTargetDirectly: boolean;
  importsTargetTransitively: boolean;
  importChain: string[];
  callsTargetSymbols: string[];
  testCallSites: CallSite[];
}

export interface MapTestsForModuleResult {
  targetModule?: string;
  targetPackage?: string;
  targetSymbols: string[];
  allTestFiles: string[];
  matchingTestFiles: string[];
  coverage: TestFileCoverage[];
  untestedSymbols: string[];
  filesInspected: number;
  truncated: boolean;
  timedOut: boolean;
  evidence: EvidenceRecord[];
}

export interface MapTestsForModuleOptions {
  workdir: string | SourceWorkdir;
  targetModule?: string; // e.g. "src/routes/api.ts" or "src/utils/reexport.ts"
  targetPackage?: string; // e.g. "qs"
  targetSymbols?: string[]; // e.g. ["parse", "merge"]
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30000;

function makeEvidenceId(kind: string): string {
  return `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Determines whether a file path is a test file.
 */
export function isTestFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const base = path.basename(norm);

  if (
    norm.includes("__tests__/") ||
    norm.startsWith("test/") ||
    norm.startsWith("tests/") ||
    norm.includes("/test/") ||
    norm.includes("/tests/") ||
    norm.startsWith("spec/") ||
    norm.startsWith("specs/") ||
    norm.includes("/spec/") ||
    norm.includes("/specs/")
  ) {
    return true;
  }

  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base) ||
    base.startsWith("test-") ||
    base.endsWith("-test.js") ||
    base.endsWith("-test.ts")
  );
}

/**
 * Maps test files to target modules, packages, and symbols using the import graph and call sites.
 */
export async function mapTestsForModule(
  options: MapTestsForModuleOptions,
): Promise<MapTestsForModuleResult> {
  let workdir: SourceWorkdir;
  if (typeof options.workdir === "string") {
    workdir = new SourceWorkdir({ baseDir: options.workdir });
  } else {
    workdir = options.workdir;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  const targetSymbols = options.targetSymbols ?? [];
  const targetModule = options.targetModule?.replace(/^\.\/?/, "");
  const targetPackage = options.targetPackage;

  // 1. Build import graph across all files
  const importGraph = await analyzeImportGraph({
    workdir,
    targetPackages: targetPackage ? [targetPackage] : undefined,
    timeoutMs,
    signal: options.signal,
  });

  const allFiles = workdir.listFiles();
  const allTestFiles = allFiles.filter(isTestFile);

  // 2. Find call sites in test files if package is specified
  let testCallSites: CallSite[] = [];
  if (targetPackage) {
    const callSiteRes = await findCallSites({
      workdir,
      targetPackage,
      symbols: targetSymbols,
      timeoutMs: timeoutMs - (Date.now() - startTime),
      signal: options.signal,
    });
    testCallSites = callSiteRes.callSites.filter((c) => isTestFile(c.file));
  }

  // 3. For each test file, determine if it reaches target module or package
  const coverageList: TestFileCoverage[] = [];
  const matchingTestFilesSet = new Set<string>();
  const testedSymbolsSet = new Set<string>();

  for (const testFile of allTestFiles) {
    let importsDirectly = false;
    let importsTransitively = false;
    let shortestChain: string[] = [];

    // Direct check: target package
    if (targetPackage) {
      const pkgUsage = importGraph.packageUsage[targetPackage];
      if (pkgUsage?.importSites.some((s) => s.file === testFile)) {
        importsDirectly = true;
        shortestChain = [testFile, targetPackage];
      }
    }

    // Direct check: target module
    if (targetModule) {
      const directImports = importGraph.fileGraph[testFile] || [];
      if (directImports.includes(targetModule)) {
        importsDirectly = true;
        shortestChain = [testFile, targetModule];
      }
    }

    // Transitive check: BFS through importGraph
    if (!importsDirectly && (targetModule || targetPackage)) {
      const queue: Array<{ file: string; path: string[] }> = [{ file: testFile, path: [testFile] }];
      const visited = new Set<string>([testFile]);

      while (queue.length > 0) {
        const { file: current, path: currentPath } = queue.shift()!;
        const neighbors = importGraph.fileGraph[current] || [];

        for (const next of neighbors) {
          if (visited.has(next)) continue;
          visited.add(next);

          const nextPath = [...currentPath, next];

          // Reached targetModule?
          if (targetModule && next === targetModule) {
            importsTransitively = true;
            shortestChain = nextPath;
            break;
          }

          // Reached file that imports targetPackage?
          if (
            targetPackage &&
            importGraph.packageUsage[targetPackage]?.importSites.some((s) => s.file === next)
          ) {
            importsTransitively = true;
            shortestChain = [...nextPath, targetPackage];
            break;
          }

          queue.push({ file: next, path: nextPath });
        }

        if (importsTransitively) break;
      }
    }

    // Find test call sites for this test file
    const fileCallSites = testCallSites.filter((c) => c.file === testFile);
    const calledSymbols = Array.from(new Set(fileCallSites.map((c) => c.symbol)));
    for (const sym of calledSymbols) {
      testedSymbolsSet.add(sym.toLowerCase());
    }

    if (importsDirectly || importsTransitively || fileCallSites.length > 0) {
      matchingTestFilesSet.add(testFile);
      coverageList.push({
        testFile,
        importsTargetDirectly: importsDirectly,
        importsTargetTransitively: importsTransitively,
        importChain: shortestChain,
        callsTargetSymbols: calledSymbols,
        testCallSites: fileCallSites,
      });
    }
  }

  const matchingTestFiles = Array.from(matchingTestFilesSet).sort();

  // Determine untested symbols
  const untestedSymbols = targetSymbols.filter((sym) => !testedSymbolsSet.has(sym.toLowerCase()));

  // Generate evidence records
  const evidence: EvidenceRecord[] = [];

  const targetName = targetPackage || targetModule || "all modules";
  evidence.push({
    id: makeEvidenceId("test_map"),
    kind: "static_search",
    ref: `tests:${targetName}`,
    excerpt: `Mapped ${allTestFiles.length} test files for '${targetName}'. Found ${matchingTestFiles.length} covering test files (${matchingTestFiles.slice(0, 5).join(", ")}${matchingTestFiles.length > 5 ? "..." : ""}). Untested symbols: [${untestedSymbols.join(", ")}].`,
    fetchedAt: Date.now(),
    tool: "map_tests_for_module",
  });

  for (const cov of coverageList.slice(0, 5)) {
    evidence.push({
      id: makeEvidenceId("test_coverage"),
      kind: "static_search",
      ref: cov.testFile,
      excerpt: `Test file '${cov.testFile}' covers '${targetName}' (direct: ${cov.importsTargetDirectly}, transitive: ${cov.importsTargetTransitively}, chain: ${cov.importChain.join(" -> ")}). Called symbols: [${cov.callsTargetSymbols.join(", ")}].`,
      fetchedAt: Date.now(),
      tool: "map_tests_for_module",
    });
  }

  return {
    targetModule,
    targetPackage,
    targetSymbols,
    allTestFiles,
    matchingTestFiles,
    coverage: coverageList,
    untestedSymbols,
    filesInspected: allFiles.length,
    truncated: importGraph.truncated,
    timedOut: importGraph.timedOut,
    evidence,
  };
}
