import { describe, it, expect, vi } from "vitest";
import type { InvestigationFinding, SandboxValidation, TraceEvent } from "@punch/shared";
import { RemediationProposal } from "@punch/shared";
import { GitHubClient } from "../tools/github.js";
import { executeTool } from "../tools/registry.js";
import { AutoApprovalGate, DenyAllApprovalGate, selectApprovalGate } from "../approval.js";
import { buildProposal, validatedManifestFiles } from "./proposal.js";
import { CompensationRegistry } from "./compensation.js";
import { openFixPr } from "./github-pr.js";
import { executeRemediation } from "./executor.js";

function finding(overrides: Partial<InvestigationFinding> = {}): InvestigationFinding {
  return {
    id: "F-1",
    dependency: "foo",
    version: "2.1.4",
    advisoryIds: ["CVE-XXXX"],
    severity: "HIGH",
    reachability: {
      verdict: "REACHABLE",
      exists: "yes",
      exposed: "yes",
      exploitable: "yes",
      affectedSymbols: ["foo.parse"],
      claimIds: ["c1"],
      summary: "foo.parse is called from src/api/parser.ts",
    },
    upgrade: { from: "2.1.4", to: "2.4.0" },
    upgradeImpact: { level: "LOW", detectedRisks: [], unknowns: [], claimIds: [] },
    sandbox: null,
    critic: "ACCEPTED",
    recommendedAction: "UPGRADE",
    claimIds: ["c1"],
    ...overrides,
  };
}

function passSandbox(overrides: Partial<SandboxValidation> = {}): SandboxValidation {
  return {
    isolation: "docker",
    baseline: null,
    candidate: {
      install: { status: "pass", exitCode: 0, durationMs: 1, logTail: "" },
      build: { status: "pass", exitCode: 0, durationMs: 1, logTail: "" },
      test: { status: "pass", exitCode: 0, durationMs: 1, logTail: "" },
      counts: { total: 187, passed: 187, failed: 0, skipped: 0 },
      failingTests: [],
    },
    newFailures: [],
    fixedFailures: [],
    changedFiles: ["package.json"],
    verdict: "PASS",
    evidenceIds: [],
    ...overrides,
  };
}

function failSandbox(): SandboxValidation {
  return {
    ...passSandbox(),
    candidate: {
      install: { status: "pass", exitCode: 0, durationMs: 1, logTail: "" },
      build: { status: "pass", exitCode: 0, durationMs: 1, logTail: "" },
      test: { status: "fail", exitCode: 1, durationMs: 1, logTail: "6 failures" },
      counts: { total: 187, passed: 181, failed: 6, skipped: 0 },
      failingTests: ["a", "b", "c", "d", "e", "f"],
    },
    newFailures: ["a", "b", "c", "d", "e", "f"],
    verdict: "FAIL",
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refBody = { ref: "refs/heads/main", object: { sha: "base-sha", type: "commit" } };
const pullBody = {
  id: 1,
  number: 7,
  title: "fix",
  body: "body",
  html_url: "https://github.com/o/r/pull/7",
  state: "open",
  head: { ref: "punch/fix-foo", sha: "head-sha" },
  base: { ref: "main", sha: "base-sha" },
};
const fileBody = (path: string) => ({
  name: path,
  path,
  sha: "file-sha",
  size: 10,
  type: "file",
  content: Buffer.from("{}").toString("base64"),
  encoding: "base64",
});

/** Route mock fetch by method + URL for the fix-PR sequence. */
function prFetch(options: { failPull?: boolean } = {}) {
  const calls: { method: string; url: string }[] = [];
  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url: urlStr });
    if (method === "GET" && urlStr.includes("/git/ref/heads/")) return json(refBody);
    if (method === "POST" && urlStr.endsWith("/git/refs")) return json(refBody, 201);
    if (method === "GET" && urlStr.includes("/contents/")) return json(fileBody("package.json"));
    if (method === "PUT" && urlStr.includes("/contents/"))
      return json({ content: { path: "package.json", sha: "new-sha" } }, 201);
    if (method === "POST" && urlStr.endsWith("/pulls")) {
      if (options.failPull) return json({ message: "validation failed" }, 422);
      return json(pullBody, 201);
    }
    if (method === "DELETE" && urlStr.includes("/git/refs/"))
      return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${urlStr}`);
  }) as typeof globalThis.fetch;
  return { mockFetch, calls };
}

describe("buildProposal", () => {
  it("proposes a pull_request for a PASS validation with an upgrade target", () => {
    const proposal = buildProposal({ finding: finding(), sandbox: passSandbox() });
    expect(RemediationProposal.safeParse(proposal).success).toBe(true);
    expect(proposal.action).toBe("pull_request");
    expect(proposal.validationVerdict).toBe("PASS");
    expect(proposal.humanReviewRequired).toBe(false);
    expect(proposal.title).toContain("foo");
    expect(proposal.validationSummary).toContain("PASS");
    expect(proposal.testSummary).toContain("187/187");
    expect(proposal.risk).toBe("LOW");
  });

  it("proposes an issue marked human review required for a FAIL validation", () => {
    const proposal = buildProposal({ finding: finding(), sandbox: failSandbox() });
    expect(proposal.action).toBe("issue");
    expect(proposal.humanReviewRequired).toBe(true);
    expect(proposal.body).toContain("human review required");
    expect(proposal.title).toContain("human review required");
  });

  it("proposes an issue marked human review required when the sandbox did not run", () => {
    const proposal = buildProposal({ finding: finding(), sandbox: null });
    expect(proposal.action).toBe("issue");
    expect(proposal.validationVerdict).toBe("NOT_RUN");
    expect(proposal.humanReviewRequired).toBe(true);
    expect(proposal.body).toContain("human review required");
  });

  it("proposes an issue when there is no upgrade target even with PASS", () => {
    const proposal = buildProposal({
      finding: finding({ upgrade: { from: "2.1.4", to: null } }),
      sandbox: passSandbox(),
    });
    expect(proposal.action).toBe("issue");
  });
});

describe("executeRemediation approval gating", () => {
  it("denial performs no GitHub write", async () => {
    const trace: TraceEvent[] = [];
    const { mockFetch } = prFetch();
    const github = new GitHubClient({ fetch: mockFetch });
    const proposal = buildProposal({ finding: finding(), sandbox: passSandbox() });

    const outcome = await executeRemediation(
      {
        github,
        approvalGate: new DenyAllApprovalGate("denied in test"),
        trace: { write: (e) => void trace.push(e) },
      },
      {
        proposal,
        target: { owner: "o", repo: "r", base: "main", branch: "punch/fix-foo" },
        sandbox: passSandbox(),
        validatedFiles: { "package.json": "{}" },
      },
    );

    expect(outcome).toMatchObject({ status: "denied", writes: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    const kinds = trace.map((e) => e.kind);
    expect(kinds).toContain("remediation.proposed");
    expect(kinds).toContain("approval.requested");
    expect(kinds).toContain("approval.denied");
    expect(kinds).not.toContain("approval.granted");
  });

  it("--unattended denies everything", async () => {
    const gate = selectApprovalGate({ unattended: true });
    const decision = await gate.requestApproval({
      approvalId: "a",
      tool: "github_create_issue",
      payload: {},
    });
    expect(decision.approved).toBe(false);
  });

  it("approval creates the issue exactly once against a mocked GitHub", async () => {
    const trace: TraceEvent[] = [];
    const mockFetch = vi.fn(async () =>
      json(
        {
          id: 1,
          number: 42,
          title: "t",
          body: "b",
          html_url: "https://github.com/o/r/issues/42",
          state: "open",
          created_at: "2026-09-26T12:00:00Z",
        },
        201,
      ),
    );
    const github = new GitHubClient({ fetch: mockFetch });
    const proposal = buildProposal({ finding: finding(), sandbox: failSandbox() });

    const outcome = await executeRemediation(
      {
        github,
        approvalGate: new AutoApprovalGate("operator"),
        trace: { write: (e) => void trace.push(e) },
      },
      { proposal, target: { owner: "o", repo: "r" } },
    );

    expect(outcome.status).toBe("issue_created");
    expect(outcome.writes).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(trace.map((e) => e.kind)).toContain("approval.granted");
  });

  it("approval opens the PR exactly once with finding, evidence, validation and critic in the body", async () => {
    const trace: TraceEvent[] = [];
    const { mockFetch, calls } = prFetch();
    const github = new GitHubClient({ fetch: mockFetch });
    const proposal = buildProposal({ finding: finding(), sandbox: passSandbox() });

    const outcome = await executeRemediation(
      {
        github,
        approvalGate: new AutoApprovalGate("operator"),
        trace: { write: (e) => void trace.push(e) },
      },
      {
        proposal,
        target: { owner: "o", repo: "r", base: "main", branch: "punch/fix-foo" },
        sandbox: passSandbox(),
        validatedFiles: { "package.json": '{"name":"x"}' },
      },
    );

    expect(outcome.status).toBe("pr_opened");
    expect(outcome.writes).toBe(1);
    const pulls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls"));
    const branches = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/refs"));
    expect(branches).toHaveLength(1);
    expect(pulls).toHaveLength(1);
    expect(proposal.body).toContain("foo");
    expect(proposal.body).toContain("PASS");
    expect(proposal.body).toContain("ACCEPTED");
  });

  it("a non-PASS proposal is never opened as a PR, even if forced", async () => {
    const { mockFetch } = prFetch();
    const github = new GitHubClient({ fetch: mockFetch });
    const proposal = {
      ...buildProposal({ finding: finding(), sandbox: failSandbox() }),
      action: "pull_request" as const,
    };

    const outcome = await executeRemediation(
      { github, approvalGate: new AutoApprovalGate("operator") },
      {
        proposal,
        target: { owner: "o", repo: "r", base: "main", branch: "punch/fix-foo" },
        sandbox: failSandbox(),
        validatedFiles: { "package.json": "{}" },
      },
    );

    expect(outcome.status).toBe("human_review_required");
    expect(outcome.writes).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("fix-PR compensation", () => {
  it("deletes the branch and traces compensation.ran when PR creation fails", async () => {
    const trace: TraceEvent[] = [];
    const { mockFetch, calls } = prFetch({ failPull: true });
    const github = new GitHubClient({ fetch: mockFetch });
    const registry = new CompensationRegistry({ write: (e) => void trace.push(e) });

    await expect(
      openFixPr(
        github,
        {
          owner: "o",
          repo: "r",
          base: "main",
          branch: "punch/fix-foo",
          title: "fix",
          body: "body",
          sandbox: passSandbox(),
          validatedFiles: { "package.json": "{}" },
        },
        registry,
      ),
    ).rejects.toThrow();

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    const compensated = trace.filter((e) => e.kind === "compensation.ran");
    expect(compensated).toHaveLength(1);
    expect(compensated[0]).toMatchObject({ action: "delete_branch", ok: true });
  });

  it("commits exactly the validated manifest files and refuses anything else", () => {
    const files = validatedManifestFiles(passSandbox(), {
      "package.json": "{}",
      "src/evil.ts": "x",
    });
    expect(Object.keys(files)).toEqual(["package.json"]);
  });

  it("refuses a PR with no validated manifest changes", async () => {
    const github = new GitHubClient({ fetch: vi.fn() });
    await expect(
      openFixPr(
        github,
        {
          owner: "o",
          repo: "r",
          base: "main",
          branch: "punch/fix-foo",
          title: "fix",
          body: "body",
          sandbox: passSandbox({ changedFiles: [] }),
          validatedFiles: {},
        },
        new CompensationRegistry(),
      ),
    ).rejects.toThrow(/no validated manifest/);
  });
});

describe("github_open_fix_pr tool", () => {
  it("is irreversible and denied without a GitHub write", async () => {
    const trace: TraceEvent[] = [];
    const mockFetch = vi.fn();
    const result = await executeTool(
      "github_open_fix_pr",
      {
        owner: "o",
        repo: "r",
        branch: "b",
        title: "t",
        body: "b",
        files: { "package.json": "{}" },
      },
      {
        clients: { github: new GitHubClient({ fetch: mockFetch }) },
        approvalGate: new DenyAllApprovalGate("unattended"),
        traceSink: (e) => void trace.push(e),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("denied");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses non-manifest files without touching GitHub", async () => {
    const trace: TraceEvent[] = [];
    const mockFetch = vi.fn();
    const result = await executeTool(
      "github_open_fix_pr",
      { owner: "o", repo: "r", branch: "b", title: "t", body: "b", files: { "src/evil.ts": "x" } },
      {
        clients: { github: new GitHubClient({ fetch: mockFetch }) },
        approvalGate: new AutoApprovalGate("operator"),
        traceSink: (e) => void trace.push(e),
      },
    );
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
