import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { SourceWorkdir } from "./source-fetch.js";
import type { GitHubClient } from "../tools/github.js";
import type { TraceEvent } from "@punch/shared";

describe("SourceWorkdir and source-fetch", () => {
  const fixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");
  let workdir: SourceWorkdir | null = null;

  afterEach(() => {
    if (workdir) {
      workdir.cleanup();
      workdir = null;
    }
  });

  it("populates from a local directory into a read-only workdir", async () => {
    workdir = new SourceWorkdir({ runId: "test_run_1" });
    expect(workdir.isReadOnly).toBe(true);

    const result = await workdir.populateFromLocal(fixtureDir);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.sourceType).toBe("local");
    expect(result.files).toContain("src/index.ts");
    expect(result.files).toContain("src/routes/api.ts");
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.kind).toBe("file");
  });

  it("prevents directory traversal outside workdir", () => {
    workdir = new SourceWorkdir({ runId: "test_run_security" });
    expect(() => workdir!.resolvePath("../../../etc/passwd")).toThrow(/Path traversal denied/);
  });

  it("reads files, records inspected files, and generates EvidenceRecord", async () => {
    const events: TraceEvent[] = [];
    workdir = new SourceWorkdir({
      runId: "test_run_inspect",
      traceSink: (e) => events.push(e),
    });
    await workdir.populateFromLocal(fixtureDir);

    const readRes = workdir.readFile("src/routes/api.ts", { startLine: 1, endLine: 10 });
    expect(readRes.filePath).toBe("src/routes/api.ts");
    expect(readRes.totalLines).toBeGreaterThanOrEqual(10);
    expect(readRes.content).toContain("express");
    expect(readRes.evidence.kind).toBe("file");
    expect(readRes.evidence.ref).toBe("src/routes/api.ts");
    expect(readRes.evidence.excerpt).toContain("Lines 1-10");

    // Check files inspected list
    const inspected = workdir.getFilesInspected();
    expect(inspected).toContain("src/routes/api.ts");

    // Check recorded evidence
    const evidenceList = workdir.getRecordedEvidence();
    expect(evidenceList.length).toBeGreaterThanOrEqual(2); // source fetch + file read

    // Check trace sink event
    expect(events.some((e) => e.kind === "evidence.recorded")).toBe(true);
  });

  it("enforces maxFiles and maxFileSize limits with truncated flag", async () => {
    workdir = new SourceWorkdir({
      runId: "test_run_limits",
      maxFiles: 3,
      maxFileSize: 50, // 50 bytes
    });

    const result = await workdir.populateFromLocal(fixtureDir);
    expect(result.fileCount).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });

  it("populates from GitHubClient mock responses", async () => {
    workdir = new SourceWorkdir({ runId: "test_run_gh" });

    // Mock GitHub client
    const mockGhClient = {
      getContents: async (owner: string, repo: string, reqPath: string) => {
        if (reqPath === "") {
          return {
            data: [
              { name: "package.json", path: "package.json", sha: "1", size: 100, type: "file" },
              { name: "src", path: "src", sha: "2", size: 0, type: "dir" },
            ],
            status: 200,
            retries: 0,
            cached: false,
          };
        }
        if (reqPath === "src") {
          return {
            data: [
              { name: "index.ts", path: "src/index.ts", sha: "3", size: 120, type: "file" },
            ],
            status: 200,
            retries: 0,
            cached: false,
          };
        }
        if (reqPath === "package.json") {
          return {
            data: {
              name: "package.json",
              path: "package.json",
              sha: "1",
              size: 100,
              type: "file",
              content: Buffer.from(JSON.stringify({ name: "mock-repo" })).toString("base64"),
              encoding: "base64",
              decodedContent: JSON.stringify({ name: "mock-repo" }),
            },
            status: 200,
            retries: 0,
            cached: false,
          };
        }
        if (reqPath === "src/index.ts") {
          return {
            data: {
              name: "index.ts",
              path: "src/index.ts",
              sha: "3",
              size: 120,
              type: "file",
              content: Buffer.from("console.log('hello world');").toString("base64"),
              encoding: "base64",
              decodedContent: "console.log('hello world');",
            },
            status: 200,
            retries: 0,
            cached: false,
          };
        }
        throw new Error(`Path not found: ${reqPath}`);
      },
    } as unknown as GitHubClient;

    const result = await workdir.populateFromGitHub({
      owner: "test-org",
      repo: "test-repo",
      client: mockGhClient,
    });

    expect(result.fileCount).toBe(2);
    expect(result.sourceType).toBe("github");
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("src/index.ts");
    expect(workdir.readFile("src/index.ts").content).toBe("console.log('hello world');");
  });
});
