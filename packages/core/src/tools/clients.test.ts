import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GitHubClient } from "./github.js";
import { OSVClient } from "./osv.js";
import { NpmClient } from "./npm.js";
import { GitHubAdvisoryClient } from "./gh-advisory.js";
import {
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  buildDependencyInventory,
} from "./inventory.js";

function loadFixture(relPath: string): string {
  const fullPath = path.resolve(process.cwd(), "fixtures", relPath);
  if (fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath, "utf-8");
  }
  // Try relative from test directory as fallback
  const altPath = path.resolve(__dirname, "../../../../fixtures", relPath);
  return fs.readFileSync(altPath, "utf-8");
}

describe("Clients against Recorded Offline Fixtures", () => {
  describe("GitHubClient", () => {
    it("fetches and decodes package.json contents from fixture", async () => {
      const fixtureJson = loadFixture("github/express_package_json.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new GitHubClient({ fetch: mockFetch });
      const res = await client.getContents("expressjs", "express", "package.json");

      expect(res.status).toBe(200);
      if (!Array.isArray(res.data)) {
        expect(res.data.name).toBe("package.json");
        expect(res.data.decodedContent).toBeTruthy();
        expect(res.data.decodedContent).toContain('"name": "express"');
        expect(res.data.decodedContent).toContain('"version": "4.16.0"');
      }
    });

    it("fetches and parses releases from fixture", async () => {
      const fixtureJson = loadFixture("github/express_releases.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new GitHubClient({ fetch: mockFetch });
      const res = await client.getReleases("expressjs", "express");

      expect(res.status).toBe(200);
      expect(res.data).toHaveLength(2);
      expect(res.data[0]?.tag_name).toBe("4.18.2");
      expect(res.data[0]?.body).toContain("Update qs to 6.11.0");
    });

    it("fetches and parses commit compare from fixture", async () => {
      const fixtureJson = loadFixture("github/express_compare.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new GitHubClient({ fetch: mockFetch });
      const res = await client.compareCommits("expressjs", "express", "4.16.0", "4.18.2");

      expect(res.status).toBe(200);
      expect(res.data.status).toBe("ahead");
      expect(res.data.total_commits).toBe(120);
      expect(res.data.commits[0]?.commit.message).toContain("GHSA-hrpp-h998-j3pp");
    });

    it("creates an issue and validates response", async () => {
      const mockIssue = {
        id: 998877,
        number: 42,
        title: "Security: Upgrade qs to 6.11.0",
        body: "Remediation report...",
        html_url: "https://github.com/expressjs/express/issues/42",
        state: "open",
        created_at: "2026-09-26T12:00:00Z",
      };

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockIssue), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new GitHubClient({ fetch: mockFetch });
      const res = await client.createIssue("expressjs", "express", {
        title: mockIssue.title,
        body: mockIssue.body,
      });

      expect(res.status).toBe(201);
      expect(res.data.number).toBe(42);
      expect(res.data.title).toBe(mockIssue.title);
    });
  });

  describe("OSVClient", () => {
    it("queries vulnerability for a package from fixture", async () => {
      const fixtureJson = loadFixture("osv/query_qs_6_5_2.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new OSVClient({ fetch: mockFetch });
      const res = await client.query({
        package: { name: "qs", ecosystem: "npm" },
        version: "6.5.2",
      });

      expect(res.status).toBe(200);
      expect(res.data.vulns).toHaveLength(1);
      expect(res.data.vulns[0]?.id).toBe("GHSA-hrpp-h998-j3pp");
      expect(res.data.vulns[0]?.aliases).toContain("CVE-2022-24999");
    });

    it("batch queries vulnerabilities from fixture", async () => {
      const fixtureJson = loadFixture("osv/query_batch_express_deps.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new OSVClient({ fetch: mockFetch });
      const res = await client.queryBatch([
        { package: { name: "qs", ecosystem: "npm" }, version: "6.5.2" },
        { package: { name: "accepts", ecosystem: "npm" }, version: "1.3.4" },
      ]);

      expect(res.status).toBe(200);
      expect(res.data.results).toHaveLength(2);
      expect(res.data.results[0]?.vulns).toHaveLength(1);
    });
  });

  describe("NpmClient", () => {
    it("fetches package metadata and versions from fixture", async () => {
      const fixtureJson = loadFixture("npm/qs_metadata.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new NpmClient({ fetch: mockFetch });
      const res = await client.getPackageMetadata("qs");

      expect(res.status).toBe(200);
      expect(res.data.name).toBe("qs");
      expect(res.data["dist-tags"]["latest"]).toBe("6.13.0");
      expect(Object.keys(res.data.versions)).toContain("6.11.0");
    });
  });

  describe("GitHubAdvisoryClient", () => {
    it("queries GraphQL security vulnerabilities from fixture", async () => {
      const fixtureJson = loadFixture("advisory/qs_ghsa_advisories.json");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new GitHubAdvisoryClient({ fetch: mockFetch });
      const res = await client.queryAdvisories("qs", "NPM");

      expect(res.status).toBe(200);
      expect(res.data.advisories).toHaveLength(1);
      expect(res.data.advisories[0]?.ghsaId).toBe("GHSA-hrpp-h998-j3pp");
      expect(res.data.advisories[0]?.firstPatchedVersion).toBe("6.7.3");
    });
  });

  describe("Dependency Inventory Parser", () => {
    it("parses direct dependencies from package.json", () => {
      const pkgJsonStr = JSON.stringify({
        name: "test-app",
        dependencies: {
          express: "4.16.0",
          qs: "~6.5.2",
        },
        devDependencies: {
          mocha: "^3.5.0",
        },
      });

      const deps = parsePackageJson(pkgJsonStr);
      expect(deps).toHaveLength(3);

      const prodDeps = deps.filter((d) => !d.isDev);
      expect(prodDeps.map((d) => d.name)).toEqual(["express", "qs"]);

      const devDeps = deps.filter((d) => d.isDev);
      expect(devDeps.map((d) => d.name)).toEqual(["mocha"]);
    });

    it("parses resolved versions from package-lock.json v3 and builds complete inventory", () => {
      const pkgLockFixture = loadFixture("github/express_package_lock.json");
      const pkgLockObj = JSON.parse(pkgLockFixture);
      const pkgLockStr = Buffer.from(pkgLockObj.content, "base64").toString("utf-8");

      const lockMap = parsePackageLock(pkgLockStr);
      expect(lockMap.get("qs")).toBe("6.5.2");
      expect(lockMap.get("accepts")).toBe("1.3.4");

      const pkgJsonFixture = loadFixture("github/express_package_json.json");
      const pkgJsonObj = JSON.parse(pkgJsonFixture);
      const pkgJsonStr = Buffer.from(pkgJsonObj.content, "base64").toString("utf-8");

      const inventory = buildDependencyInventory({
        packageJson: pkgJsonStr,
        packageLock: pkgLockStr,
      });

      expect(inventory.manifestFound).toBe(true);
      expect(inventory.lockfileType).toBe("npm");
      expect(inventory.direct.length).toBeGreaterThan(10);

      const qsEntry = inventory.direct.find((d) => d.name === "qs");
      expect(qsEntry?.resolvedVersion).toBe("6.5.2");
    });

    it("parses pnpm-lock.yaml dependencies", () => {
      const pnpmLockContent = `
lockfileVersion: '6.0'
dependencies:
  express:
    specifier: 4.16.0
    version: 4.16.0
packages:
  /@types/node@22.0.0:
    resolution: {integrity: sha512-...}
  /qs@6.5.2:
    resolution: {integrity: sha512-...}
  /express@4.16.0:
    resolution: {integrity: sha512-...}
`;

      const pnpmMap = parsePnpmLock(pnpmLockContent);
      expect(pnpmMap.get("express")).toBe("4.16.0");
      expect(pnpmMap.get("qs")).toBe("6.5.2");
      expect(pnpmMap.get("@types/node")).toBe("22.0.0");
    });
  });
});
