import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS, getToolSpecs, executeTool, type ToolExecutionContext } from "./registry.js";
import { ToolCache } from "./cache.js";
import { AutoApprovalGate, DenyAllApprovalGate, CallbackApprovalGate } from "../approval.js";
import { GitHubClient } from "./github.js";
import { OSVClient } from "./osv.js";
import { parseChaosProfile } from "./chaos.js";
import { TraceEvent } from "@punch/shared";

describe("Tool Registry & Execution Pipeline", () => {
  describe("Tool Specifications", () => {
    it("exports valid ToolSpec objects for all core tools", () => {
      const specs = getToolSpecs();
      expect(specs.length).toBeGreaterThanOrEqual(10);

      for (const spec of specs) {
        expect(spec.name).toBeTruthy();
        expect(spec.description).toBeTruthy();
        expect(spec.inputSchema).toBeDefined();
        expect(typeof spec.inputSchema).toBe("object");
        expect(spec.inputSchema.type).toBe("object");
      }
    });

    it("marks only github_create_issue as irreversible", () => {
      expect(TOOL_SPECS.github_create_issue?.irreversible).toBe(true);

      const otherSpecs = getToolSpecs().filter((s) => s.name !== "github_create_issue");
      for (const spec of otherSpecs) {
        expect(spec.irreversible).toBe(false);
      }
    });
  });

  describe("Irreversible Tool Approval Gate", () => {
    it("denies execution and emits approval.denied when approval gate denies", async () => {
      const traceEvents: TraceEvent[] = [];
      const denyGate = new DenyAllApprovalGate("unattended automated denial");

      const mockFetch = vi.fn();
      const ghClient = new GitHubClient({ fetch: mockFetch });

      const context: ToolExecutionContext = {
        clients: { github: ghClient },
        approvalGate: denyGate,
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await executeTool(
        "github_create_issue",
        {
          owner: "expressjs",
          repo: "express",
          title: "Vulnerability Remediation",
          body: "Upgrade qs to 6.11.0",
        },
        context,
      );

      expect(result.ok).toBe(false);
      expect(result.status).toBe("denied");
      expect(result.error).toContain("unattended automated denial");
      expect(mockFetch).not.toHaveBeenCalled();

      // Check emitted trace events
      const requested = traceEvents.find((e) => e.kind === "approval.requested");
      const denied = traceEvents.find((e) => e.kind === "approval.denied");
      const toolResult = traceEvents.find((e) => e.kind === "tool.result");

      expect(requested).toBeDefined();
      expect(denied).toBeDefined();
      expect(toolResult).toBeDefined();
      if (toolResult && toolResult.kind === "tool.result") {
        expect(toolResult.ok).toBe(false);
      }
    });

    it("approves execution and emits approval.granted when approval is granted", async () => {
      const traceEvents: TraceEvent[] = [];
      const autoGate = new AutoApprovalGate("operator");

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 12345,
            number: 101,
            title: "Remediation",
            body: "Details",
            html_url: "https://github.com/expressjs/express/issues/101",
            state: "open",
            created_at: "2026-09-26T12:00:00Z",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );

      const ghClient = new GitHubClient({ fetch: mockFetch });
      const context: ToolExecutionContext = {
        clients: { github: ghClient },
        approvalGate: autoGate,
        traceSink: (e) => traceEvents.push(e),
      };

      const result = await executeTool(
        "github_create_issue",
        {
          owner: "expressjs",
          repo: "express",
          title: "Remediation",
          body: "Details",
        },
        context,
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe("ok");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const granted = traceEvents.find((e) => e.kind === "approval.granted");
      expect(granted).toBeDefined();
    });

    it("supports custom CallbackApprovalGate for interactive approvals", async () => {
      let callbackInvoked = false;
      const customGate = new CallbackApprovalGate(async (req) => {
        callbackInvoked = true;
        expect(req.tool).toBe("github_create_issue");
        return { approved: true, decidedBy: "human_user" };
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 1,
            number: 1,
            title: "T",
            body: "B",
            html_url: "http://url",
            state: "open",
            created_at: "2026-09-26",
          }),
          { status: 201 },
        ),
      );

      const ghClient = new GitHubClient({ fetch: mockFetch });
      const res = await executeTool(
        "github_create_issue",
        { owner: "o", repo: "r", title: "T", body: "B" },
        { clients: { github: ghClient }, approvalGate: customGate },
      );

      expect(callbackInvoked).toBe(true);
      expect(res.ok).toBe(true);
    });
  });

  describe("Caching & Trace Events Integration", () => {
    it("serves subsequent identical calls from cache and marks result cached: true", async () => {
      const cache = new ToolCache();
      const traceEvents: TraceEvent[] = [];

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ vulns: [{ id: "GHSA-cached-test" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const osvClient = new OSVClient({ fetch: mockFetch });
      const context: ToolExecutionContext = {
        cache,
        clients: { osv: osvClient },
        traceSink: (e) => traceEvents.push(e),
      };

      const input = { package: { name: "qs", ecosystem: "npm" }, version: "6.5.2" };

      // First execution: cache miss, executes fetch
      const res1 = await executeTool("osv_query", input, context);
      expect(res1.ok).toBe(true);
      expect(res1.cached).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second execution: cache hit, returns without calling fetch
      const res2 = await executeTool("osv_query", input, context);
      expect(res2.ok).toBe(true);
      expect(res2.cached).toBe(true);
      expect(res2.output).toEqual(res1.output);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No new network call!

      // Check trace events
      const toolResults = traceEvents.filter((e) => e.kind === "tool.result");
      expect(toolResults).toHaveLength(2);
      if (toolResults[0] && toolResults[0].kind === "tool.result") {
        expect(toolResults[0].cached).toBe(false);
      }
      if (toolResults[1] && toolResults[1].kind === "tool.result") {
        expect(toolResults[1].cached).toBe(true);
      }

      // Ensure every trace event emitted satisfies the shared TraceEvent schema
      for (const ev of traceEvents) {
        const parsed = TraceEvent.safeParse(ev);
        expect(parsed.success).toBe(true);
      }
    });

    it("injects tool chaos into tool execution pipeline", async () => {
      const chaosConfig = parseChaosProfile(["tool-empty:npm_package_metadata"]);
      const mockFetch = vi.fn();

      const res = await executeTool(
        "npm_package_metadata",
        { package: "express" },
        { chaos: chaosConfig },
      );

      expect(res.ok).toBe(true);
      expect(res.output).toEqual({});
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
