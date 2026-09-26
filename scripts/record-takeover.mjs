#!/usr/bin/env node
// Records traces/takeover.jsonl: a real offline run of fixtures/runs/takeover in which the
// researcher is killed by the operator in the middle of subtask s3 and a standby on another
// provider finishes it from the handoff, reusing the killed agent's cached tool results.
//
//   pnpm build && node scripts/record-takeover.mjs
//
// Copies the trace to apps/web/public/traces/ as well. The web board and its tests read it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  fixtureRunOptions,
  loadRunFixture,
  runLoop,
} from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "punch-record-"));
const RUN_ID = "2026-09-26-takeover";
const KILL_AFTER_CALL = "s3-c2";

const fixture = await loadRunFixture(path.join(root, "fixtures/runs/takeover"));
const base = fixtureRunOptions(fixture);

// Stand-in for model and network latency, so the timeline has a readable shape.
const TURN_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The operator's kill lands the moment the agent has read its second tool result of s3.
let handle;
let killed = false;
const adapters = new AdapterRegistry();
for (const kind of base.adapters.kinds()) {
  adapters.register(kind, (ctx) => {
    const adapter = base.adapters.create(ctx);
    return {
      capabilities: adapter.capabilities,
      test: () => adapter.test(),
      async *run(input) {
        for await (const event of adapter.run(input)) {
          yield event;
          if (event.type === "tool_result") await sleep(TURN_MS);
          if (!killed && event.type === "tool_result" && event.callId === KILL_AFTER_CALL) {
            killed = true;
            handle.kill("researcher", "killed by the operator (punch kill)");
          }
        }
      },
    };
  });
}

const result = await runLoop({
  ...base,
  adapters,
  runId: RUN_ID,
  runsDir,
  maxConcurrency: 1,
  killChannel: false,
  onReady: (h) => (handle = h),
});
if (result.status !== "completed" || !killed) {
  throw new Error(`recording failed: status ${result.status}, killed ${killed}`);
}
for (const dest of ["traces", "apps/web/public/traces"]) {
  fs.mkdirSync(path.join(root, dest), { recursive: true });
  fs.copyFileSync(result.tracePath, path.join(root, dest, "takeover.jsonl"));
}
fs.rmSync(runsDir, { recursive: true, force: true });
console.log(`recorded ${result.events.length} events to traces/takeover.jsonl (${result.status})`);
