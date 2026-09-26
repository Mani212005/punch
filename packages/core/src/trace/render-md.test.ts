import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTrace } from "./writer.js";
import { renderTraceMarkdown } from "./render-md.js";

const TRACE = path.resolve(fileURLToPath(import.meta.url), "../../../../../traces/takeover.jsonl");
const GOLDEN = path.resolve(fileURLToPath(import.meta.url), "../__fixtures__/takeover.audit.md");

describe("renderTraceMarkdown (A11)", () => {
  it("renders the committed takeover trace to the golden audit file", () => {
    const events = parseTrace(fs.readFileSync(TRACE, "utf-8"));
    const md = renderTraceMarkdown(events);

    // The audit must answer the A11 questions, not just re-dump JSON.
    expect(md).toContain("2026-09-26-takeover");
    expect(md).toContain("## Routing - why each agent was chosen");
    expect(md).toContain("standby");
    expect(md).toContain("## Tool calls");
    expect(md).toContain("cached");
    expect(md).toContain("takeover researcher: opus -> gemini");
    expect(md).toContain("detection 150ms");
    expect(md).toContain("## Critic verdicts");
    expect(md).toContain("accepted");
    expect(md).toContain("## Budget");
    expect(md).toContain("## Outcome - final report");
    expect(md).toContain("completed");

    expect(md).toBe(fs.readFileSync(GOLDEN, "utf-8"));
  });

  it("renders an empty trace without crashing", () => {
    const md = renderTraceMarkdown([]);
    expect(md).toContain("unknown");
    expect(md).toContain("No `run.started`");
  });
});
