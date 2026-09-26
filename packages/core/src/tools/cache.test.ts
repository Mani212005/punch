import { describe, it, expect } from "vitest";
import { ToolCache, canonicalJson, computeInputHash } from "./cache.js";
import { ToolResultSummary } from "@punch/shared";

describe("ToolCache & Canonical Hash", () => {
  it("normalizes JSON keys deterministically in canonicalJson", () => {
    const objA = { b: 2, a: 1, c: { y: "hello", x: "world" } };
    const objB = { c: { x: "world", y: "hello" }, a: 1, b: 2 };

    expect(canonicalJson(objA)).toBe(canonicalJson(objB));
    expect(computeInputHash("test_tool", objA)).toBe(computeInputHash("test_tool", objB));
  });

  it("stores and retrieves tool results by tool name and input", () => {
    const cache = new ToolCache();
    const input = { package: "express", version: "4.16.0" };
    const output = { vulnerabilities: [{ id: "GHSA-1234" }] };

    expect(cache.get("osv_query", input).hit).toBe(false);

    const hash = cache.set("osv_query", input, output);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // sha256 hex string

    const lookup = cache.get("osv_query", input);
    expect(lookup.hit).toBe(true);
    if (lookup.hit) {
      expect(lookup.output).toEqual(output);
      expect(lookup.inputHash).toBe(hash);
    }
  });

  it("treats differently keyed inputs or different tool names as separate cache entries", () => {
    const cache = new ToolCache();
    cache.set("tool_a", { id: 1 }, "res_a");
    cache.set("tool_b", { id: 1 }, "res_b");
    cache.set("tool_a", { id: 2 }, "res_a2");

    expect(cache.size).toBe(3);
    expect(cache.get("tool_a", { id: 1 })).toEqual({
      hit: true,
      output: "res_a",
      inputHash: computeInputHash("tool_a", { id: 1 }),
    });
    expect(cache.get("tool_b", { id: 1 })).toEqual({
      hit: true,
      output: "res_b",
      inputHash: computeInputHash("tool_b", { id: 1 }),
    });
  });

  it("extracts tool summaries matching ToolResultSummary schema for handoff packets", () => {
    const cache = new ToolCache();
    cache.set("github_get_contents", { path: "package.json" }, { name: "test" });
    cache.set("osv_query", { package: "qs" }, { vulns: [] });

    const summaries = cache.getSummaries();
    expect(summaries).toHaveLength(2);

    // Validate each summary against shared Zod schema
    for (const s of summaries) {
      const parsed = ToolResultSummary.safeParse(s);
      expect(parsed.success).toBe(true);
    }
  });

  it("hydrates from previous handoff summaries and serves cache hits immediately", () => {
    const cache = new ToolCache();
    const summaries = [
      {
        tool: "osv_query",
        inputHash: computeInputHash("osv_query", { package: "qs", version: "6.5.2" }),
        input: { package: "qs", version: "6.5.2" },
        output: { vulns: [{ id: "GHSA-hrpp-h998-j3pp" }] },
      },
    ];

    cache.hydrate(summaries);
    expect(cache.size).toBe(1);

    const hit = cache.get("osv_query", { package: "qs", version: "6.5.2" });
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.output).toEqual({ vulns: [{ id: "GHSA-hrpp-h998-j3pp" }] });
    }
  });
});
