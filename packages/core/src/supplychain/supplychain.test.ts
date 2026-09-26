import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { InvestigationFinding } from "@punch/shared";
import { NpmPackageMetadataSchema, type NpmPackageMetadata } from "../tools/npm.js";
import { EvidenceLedger, ReportRenderer } from "../ledger/index.js";
import { executeTool } from "../tools/registry.js";
import { analyzeSupplyChain, findPreviousVersion } from "./signals.js";
import { runSupplyChainPass } from "./pass.js";

const dir = resolve(import.meta.dirname, "../../../../fixtures/npm/supplychain");
function load(name: string): NpmPackageMetadata {
  return NpmPackageMetadataSchema.parse(JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8")));
}
const kinds = (name: string) =>
  analyzeSupplyChain(load(name), { version: "1.0.1" }).map((s) => s.kind);

describe("analyzeSupplyChain", () => {
  it("does not flag a clean package", () => {
    expect(kinds("clean")).toEqual([]);
  });

  it("flags a suspicious install script as HIGH", () => {
    const signals = analyzeSupplyChain(load("install-script"), { version: "1.0.1" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "install_script",
      severity: "HIGH",
      comparedTo: "1.0.0",
    });
  });

  it("flags a new benign install script as MEDIUM and ignores an unchanged one", () => {
    const meta = load("clean");
    (meta.versions["1.0.1"] as { scripts?: Record<string, string> }).scripts = {
      postinstall: "node build.js",
    };
    expect(analyzeSupplyChain(meta, { version: "1.0.1" })[0]).toMatchObject({ severity: "MEDIUM" });
    (meta.versions["1.0.0"] as { scripts?: Record<string, string> }).scripts = {
      postinstall: "node build.js",
    };
    expect(analyzeSupplyChain(meta, { version: "1.0.1" })).toEqual([]);
  });

  it("flags a publisher who was not a prior maintainer", () => {
    const signals = analyzeSupplyChain(load("maintainer-change"), { version: "1.0.1" });
    expect(signals.map((s) => s.kind)).toEqual(["maintainer_change"]);
    expect(signals[0]?.severity).toBe("HIGH");
  });

  it("flags unexpected dependency additions", () => {
    expect(kinds("new-dependency")).toEqual(["new_dependency"]);
  });

  it("flags size and file count jumps", () => {
    const signals = analyzeSupplyChain(load("release-change"), { version: "1.0.1" });
    expect(signals.map((s) => s.kind)).toEqual(["release_change", "release_change"]);
  });

  it("flags lost provenance and missing integrity", () => {
    expect(kinds("provenance-lost")).toEqual(["provenance_regression"]);
    expect(kinds("integrity-missing")).toEqual(["integrity_missing"]);
  });

  it("flags version gaps and dormancy", () => {
    const meta = load("clean");
    meta.versions["3.0.0"] = { ...(meta.versions["1.0.1"] as object), version: "3.0.0" };
    meta.time["3.0.0"] = "2027-01-01T00:00:00.000Z";
    const signals = analyzeSupplyChain(meta, { version: "3.0.0", previousVersion: "1.0.1" });
    expect(signals.map((s) => s.kind)).toEqual(["release_change", "release_change"]);
  });

  it("finds the previous release by publish time and skips comparisons for a first release", () => {
    const meta = load("clean");
    expect(findPreviousVersion(meta, "1.0.1")).toBe("1.0.0");
    expect(findPreviousVersion(meta, "1.0.0")).toBeUndefined();
    expect(analyzeSupplyChain(meta, { version: "1.0.0" })).toEqual([]);
  });
});

function finding(dependency: string): InvestigationFinding {
  return {
    id: `f-${dependency}`,
    dependency,
    version: "1.0.1",
    advisoryIds: ["GHSA-x"],
    severity: "HIGH",
    reachability: {
      verdict: "UNKNOWN",
      exists: "unknown",
      exposed: "unknown",
      exploitable: "unknown",
      affectedSymbols: [],
      claimIds: [],
      summary: "",
    },
    upgrade: { from: "1.0.1", to: "1.0.2" },
    upgradeImpact: null,
    sandbox: null,
    critic: "PENDING",
    recommendedAction: "MONITOR",
    claimIds: [],
  };
}

describe("runSupplyChainPass", () => {
  const fetchMetadata = async (name: string) =>
    name === "down" ? undefined : load(name === "clean-pkg" ? "clean" : "install-script");

  it("attaches signals beside flagged findings, records the ledger, and renders them", async () => {
    const ledger = new EvidenceLedger("run-1");
    const result = await runSupplyChainPass(
      [finding("bad"), finding("clean-pkg"), finding("down")],
      { fetchMetadata, ledger },
    );
    expect(result[0]?.supplyChain?.[0]?.kind).toBe("install_script");
    expect(result[0]?.claimIds).toEqual(["claim-supplychain-f-bad"]);
    expect(result[1]?.supplyChain).toBeUndefined();
    expect(result[2]?.supplyChain).toBeUndefined();
    expect(ledger.getAllEvidence()).toHaveLength(1);
    expect(ledger.getClaimsByFinding("f-bad")).toHaveLength(1);

    const renderer = new ReportRenderer(ledger);
    const report = renderer.buildReport("o/r", 3, 3, result);
    const md = renderer.renderMarkdown(report);
    expect(md).toContain("Supply-chain signals:\n! install_script (HIGH)");
    expect(md.match(/Supply-chain signals:/g)).toHaveLength(1);
  });
});

describe("analyze_supply_chain tool", () => {
  it("runs through the dispatcher with an injected npm client", async () => {
    const npm = {
      getPackageMetadata: async () => ({ data: load("install-script") }),
    } as never;
    const res = await executeTool<{ signals: { kind: string }[] }>(
      "analyze_supply_chain",
      { package: "install-script-pkg", version: "1.0.1" },
      { clients: { npm } },
    );
    expect(res.ok).toBe(true);
    expect(res.output?.signals.map((s) => s.kind)).toEqual(["install_script"]);
  });
});
