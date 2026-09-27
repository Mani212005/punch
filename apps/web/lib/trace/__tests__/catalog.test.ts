import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_TRACES } from "../catalog";
import { TraceEvent } from "@punch/shared";

const tracesDir = resolve(__dirname, "../../../../../traces");

describe("demo trace catalog", () => {
  it("offers every committed trace except the roles fixture, each schema-valid", () => {
    const ids = DEMO_TRACES.map((t) => t.id).sort();
    const committed = readdirSync(tracesDir)
      .filter((f) => f.endsWith(".jsonl") && f !== "investigation-roles.jsonl")
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
    expect(ids).toEqual(committed);
    for (const id of ids) {
      const lines = readFileSync(resolve(tracesDir, `${id}.jsonl`), "utf8")
        .trim()
        .split("\n");
      for (const line of lines) expect(TraceEvent.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });
});
