import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyzeImportGraph } from "./import-graph.js";

describe("analyzeImportGraph", () => {
  const expressFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");

  it("builds import graph and identifies used packages across ESM and CommonJS", async () => {
    const result = await analyzeImportGraph({
      workdir: expressFixtureDir,
      targetPackages: ["express", "qs", "lodash", "unused-lib"],
    });

    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.importedPackages).toContain("express");
    expect(result.importedPackages).toContain("qs");
    expect(result.importedPackages).toContain("lodash");

    // express is used
    expect(result.packageUsage["express"]?.used).toBe(true);
    expect(result.packageUsage["express"]?.importCount).toBeGreaterThan(0);

    // qs is used
    expect(result.packageUsage["qs"]?.used).toBe(true);
    expect(result.packageUsage["qs"]?.importedSymbols).toEqual(
      expect.arrayContaining(["default", "parse", "stringify"]),
    );

    // lodash is used
    expect(result.packageUsage["lodash"]?.used).toBe(true);

    // unused-lib is proved UNUSED
    expect(result.packageUsage["unused-lib"]?.used).toBe(false);
    expect(result.packageUsage["unused-lib"]?.importCount).toBe(0);

    // Check evidence records
    const unusedEvidence = result.evidence.find((e) => e.ref === "package:unused-lib");
    expect(unusedEvidence).toBeDefined();
    expect(unusedEvidence?.excerpt).toContain("UNUSED");

    const usedEvidence = result.evidence.find((e) => e.ref === "package:qs");
    expect(usedEvidence).toBeDefined();
    expect(usedEvidence?.excerpt).toContain("USED");
  });

  it("tracks re-exports across modules", async () => {
    const result = await analyzeImportGraph({
      workdir: expressFixtureDir,
    });

    // src/utils/reexport.ts re-exports parse from qs
    const reexport = result.reExports.find(
      (r) => r.exportedSymbol === "parse" && r.packageName === "qs",
    );
    expect(reexport).toBeDefined();
    expect(reexport?.file).toBe("src/utils/reexport.ts");
    expect(reexport?.sourceSymbol).toBe("parse");
  });

  it("detects dynamic requires and eval with explicit UNKNOWN flag", async () => {
    const result = await analyzeImportGraph({
      workdir: expressFixtureDir,
    });

    expect(result.hasUnknowns).toBe(true);
    expect(result.dynamicImports.length).toBeGreaterThan(0);

    const dynamicReq = result.dynamicImports.find((d) => d.rawExpression.includes("require("));
    expect(dynamicReq).toBeDefined();
    expect(dynamicReq?.file).toBe("src/dynamic/plugin.ts");

    const evalExp = result.dynamicImports.find((d) => d.rawExpression.includes("eval"));
    expect(evalExp).toBeDefined();
    expect(evalExp?.file).toBe("src/dynamic/plugin.ts");
  });

  it("builds file dependency graph and reverse graph", async () => {
    const result = await analyzeImportGraph({
      workdir: expressFixtureDir,
    });

    // src/index.ts imports src/routes/api.ts
    const indexImports = result.fileGraph["src/index.ts"];
    expect(indexImports).toBeDefined();
    expect(indexImports?.some((f) => f.includes("routes/api"))).toBe(true);

    // reverse graph: src/routes/api.ts is imported by src/index.ts
    const apiFile = Object.keys(result.fileGraph).find((f) => f.includes("routes/api.ts"));
    expect(apiFile).toBeDefined();
    if (apiFile) {
      expect(result.reverseFileGraph[apiFile]).toContain("src/index.ts");
    }
  });

  it("enforces maxFiles and timeout limits with truncated flag", async () => {
    const result = await analyzeImportGraph({
      workdir: expressFixtureDir,
      maxFiles: 2,
    });

    expect(result.filesAnalyzed).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });
});
