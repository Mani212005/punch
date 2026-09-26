import { describe, it, expect } from "vitest";
import path from "node:path";
import { mapTestsForModule, isTestFile } from "./test-map.js";

describe("mapTestsForModule", () => {
  const expressFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");
  const nextjsFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/nextjs-app");

  it("identifies test files correctly", () => {
    expect(isTestFile("tests/api.test.ts")).toBe(true);
    expect(isTestFile("src/routes/__tests__/api.spec.js")).toBe(true);
    expect(isTestFile("src/routes/api.ts")).toBe(false);
    expect(isTestFile("index.ts")).toBe(false);
  });

  it("maps test files directly importing a target package (qs)", async () => {
    const result = await mapTestsForModule({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      targetSymbols: ["parse"],
    });

    expect(result.allTestFiles.length).toBeGreaterThanOrEqual(2);
    expect(result.allTestFiles).toContain("tests/api.test.ts");
    expect(result.allTestFiles).toContain("tests/unit.test.ts");

    // tests/api.test.ts directly imports qs and calls qs.parse
    expect(result.matchingTestFiles).toContain("tests/api.test.ts");
    const apiTestCov = result.coverage.find((c) => c.testFile === "tests/api.test.ts");
    expect(apiTestCov).toBeDefined();
    expect(apiTestCov?.importsTargetDirectly).toBe(true);
    expect(apiTestCov?.callsTargetSymbols).toContain("parse");
    expect(apiTestCov?.testCallSites.length).toBeGreaterThan(0);
  });

  it("maps test files transitively importing a target module (src/services/data.ts -> qs)", async () => {
    const result = await mapTestsForModule({
      workdir: expressFixtureDir,
      targetModule: "src/services/data.ts",
      targetSymbols: ["processData"],
    });

    // tests/unit.test.ts imports src/services/data.ts
    expect(result.matchingTestFiles).toContain("tests/unit.test.ts");
    const unitTestCov = result.coverage.find((c) => c.testFile === "tests/unit.test.ts");
    expect(unitTestCov).toBeDefined();
    expect(unitTestCov?.importsTargetDirectly).toBe(true);
  });

  it("detects untested symbols when symbols are not referenced in any test", async () => {
    const result = await mapTestsForModule({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      targetSymbols: ["parse", "untestedMethod123"],
    });

    expect(result.untestedSymbols).toContain("untestedMethod123");
    expect(result.untestedSymbols).not.toContain("parse");
  });

  it("maps test files in Next.js fixture app", async () => {
    const result = await mapTestsForModule({
      workdir: nextjsFixtureDir,
      targetPackage: "jsonwebtoken",
      targetSymbols: ["verify", "decode"],
    });

    expect(result.allTestFiles).toContain("tests/auth.test.ts");
    expect(result.matchingTestFiles).toContain("tests/auth.test.ts");

    const authTestCov = result.coverage.find((c) => c.testFile === "tests/auth.test.ts");
    expect(authTestCov).toBeDefined();
    expect(authTestCov?.importsTargetDirectly).toBe(true);
    expect(authTestCov?.callsTargetSymbols).toEqual(expect.arrayContaining(["verify"]));
  });

  it("generates valid EvidenceRecords for test mapping", async () => {
    const result = await mapTestsForModule({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      targetSymbols: ["parse"],
    });

    expect(result.evidence.length).toBeGreaterThan(0);
    const summaryEv = result.evidence.find((e) => e.ref.startsWith("tests:"));
    expect(summaryEv).toBeDefined();
    expect(summaryEv?.kind).toBe("static_search");
    expect(summaryEv?.tool).toBe("map_tests_for_module");
  });
});
