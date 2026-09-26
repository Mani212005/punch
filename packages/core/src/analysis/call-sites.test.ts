import { describe, it, expect } from "vitest";
import path from "node:path";
import { findCallSites } from "./call-sites.js";

describe("findCallSites", () => {
  const expressFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");
  const fastifyFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/fastify-app");
  const nextjsFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/nextjs-app");

  it("finds known call sites for default and member imports (qs.parse)", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      symbols: ["parse"],
    });

    expect(result.found).toBe(true);
    expect(result.totalCallSites).toBeGreaterThanOrEqual(1);

    // Should find qs.parse in src/routes/api.ts
    const apiCallSite = result.callSites.find((c) => c.file === "src/routes/api.ts");
    expect(apiCallSite).toBeDefined();
    expect(apiCallSite?.symbol).toBe("parse");
    expect(apiCallSite?.line).toBeGreaterThan(0);
    expect(apiCallSite?.column).toBeGreaterThan(0);
    expect(apiCallSite?.endLine).toBeGreaterThanOrEqual(apiCallSite?.line ?? 0);
    expect(apiCallSite?.snippet).toContain("qs.parse");
    expect(apiCallSite?.confidence).toBe("certain");
  });

  it("finds call sites through re-exports (re-exported parse in src/services/data.ts)", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      symbols: ["parse"],
    });

    const dataCallSite = result.callSites.find((c) => c.file === "src/services/data.ts");
    expect(dataCallSite).toBeDefined();
    expect(dataCallSite?.symbol).toBe("parse");
    expect(dataCallSite?.importStyle).toBe("reexport");
    expect(dataCallSite?.snippet).toContain("parse(raw)");
  });

  it("finds call sites for named and aliased imports (lodash.merge and lodash.get)", async () => {
    const resultMerge = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "lodash",
      symbols: ["merge"],
    });

    expect(resultMerge.found).toBe(true);
    const mergeSite = resultMerge.callSites.find((c) => c.file === "src/routes/api.ts");
    expect(mergeSite).toBeDefined();
    expect(mergeSite?.symbol).toBe("merge");
    expect(mergeSite?.snippet).toContain("_.merge");

    const resultGet = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "lodash",
      symbols: ["get"],
    });

    expect(resultGet.found).toBe(true);
    const getSite = resultGet.callSites.find((c) => c.file === "src/services/data.ts");
    expect(getSite).toBeDefined();
    expect(getSite?.symbol).toBe("get");
    expect(getSite?.snippet).toContain("lodashGet");
  });

  it("returns found: false and evidence of absence when symbol is never called", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      symbols: ["nonExistentMethod", "unescape"],
    });

    expect(result.found).toBe(false);
    expect(result.callSites.length).toBe(0);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0]?.excerpt).toContain("no call sites found");
  });

  it("returns found: false for an unused package", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "unused-lib",
      symbols: ["doSomething"],
    });

    expect(result.found).toBe(false);
    expect(result.callSites.length).toBe(0);
  });

  it("identifies dynamic requires and eval with explicit UNKNOWN evidence", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      symbols: ["parse"],
    });

    expect(result.hasUnknowns).toBe(true);
    expect(result.dynamicUsages.length).toBeGreaterThan(0);
    const dynReq = result.dynamicUsages.find(
      (d) => d.file === "src/dynamic/plugin.ts" && d.reason.includes("require"),
    );
    expect(dynReq).toBeDefined();

    const evalUsage = result.dynamicUsages.find(
      (d) => d.file === "src/dynamic/plugin.ts" && d.reason.includes("eval"),
    );
    expect(evalUsage).toBeDefined();
    expect(evalUsage?.reason).toContain("eval()");

    const unknownEvidence = result.evidence.find((e) => e.excerpt.includes("Explicit UNKNOWN"));
    expect(unknownEvidence).toBeDefined();
  });

  it("finds call sites in fastify and nextjs repos", async () => {
    // Fastify app: axios.get / axios.post
    const fastifyRes = await findCallSites({
      workdir: fastifyFixtureDir,
      targetPackage: "axios",
      symbols: ["get", "post"],
    });
    expect(fastifyRes.found).toBe(true);
    expect(fastifyRes.callSites.some((c) => c.symbol === "get")).toBe(true);
    expect(fastifyRes.callSites.some((c) => c.symbol === "post")).toBe(true);

    // Next.js app: jwt.verify / jwt.decode
    const nextjsRes = await findCallSites({
      workdir: nextjsFixtureDir,
      targetPackage: "jsonwebtoken",
      symbols: ["verify", "decode"],
    });
    expect(nextjsRes.found).toBe(true);
    expect(nextjsRes.callSites.some((c) => c.symbol === "verify")).toBe(true);
    expect(nextjsRes.callSites.some((c) => c.symbol === "decode")).toBe(true);
  });

  it("enforces maxResults limit and sets truncated flag", async () => {
    const result = await findCallSites({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      symbols: ["parse"],
      maxResults: 1,
    });

    expect(result.callSites.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
