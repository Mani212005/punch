#!/usr/bin/env node
// Records traces/investigation-roles.jsonl: an offline run of fixtures/runs/investigation with one
// REACHABLE and one NOT_REACHABLE finding and a critic rejection -> targeted reachability
// replan -> accept cycle.
//
//   pnpm build && node scripts/record-investigation.mjs
//
// Copies the trace to apps/web/public/traces/ as well.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRunOptions, loadRunFixture, runLoop } from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-record-"));

const fixture = await loadRunFixture(path.join(root, "fixtures/runs/investigation"));
const result = await runLoop(
  fixtureRunOptions(fixture, { runId: "2026-09-26-investigation", runsDir, toolTimeoutMs: 10000 }),
);
if (result.status !== "completed" || result.traceErrors.length > 0) {
  throw new Error(`recording failed: ${result.status} ${result.traceErrors.join("; ")}`);
}
// Tool inputs carry the fixture repo's absolute path; store it repo-relative so the artifact is portable.
const text = fs
  .readFileSync(result.tracePath, "utf-8")
  .split(`${root}/`)
  .join("")
  .split(root)
  .join(".");
for (const dest of ["traces", "apps/web/public/traces"]) {
  fs.mkdirSync(path.join(root, dest), { recursive: true });
  fs.writeFileSync(path.join(root, dest, "investigation-roles.jsonl"), text);
}
fs.rmSync(runsDir, { recursive: true, force: true });
console.log(
  `recorded ${result.events.length} events to traces/investigation-roles.jsonl (${result.status})`,
);
