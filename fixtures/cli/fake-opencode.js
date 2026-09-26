#!/usr/bin/env node

// Fake `opencode run --format json` binary for unit tests.
// Emits the real envelope shape observed from opencode 1.18.x:
// text nests under `part` ({"type":"text","part":{"type":"text","text":"..."}})
// and token counts arrive on step_finish
// ({"type":"step_finish","part":{"type":"step-finish","tokens":{"input":n,"output":n}}}).

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log("1.18.32");
  process.exit(0);
}

const mode = process.env.FAKE_CLI_MODE || "success";
const allArgs = args.join(" ");

function textEvent(text) {
  console.log(JSON.stringify({ type: "text", timestamp: Date.now(), part: { type: "text", text } }));
}

function stepStart() {
  console.log(
    JSON.stringify({ type: "step_start", timestamp: Date.now(), part: { type: "step-start" } }),
  );
}

function stepFinish(input, output) {
  console.log(
    JSON.stringify({
      type: "step_finish",
      timestamp: Date.now(),
      part: { type: "step-finish", reason: "stop", tokens: { input, output } },
    }),
  );
}

function toolEvent(name, input) {
  console.log(JSON.stringify({ type: "tool_use", name, input }));
}

if (mode === "error") {
  console.error("Error: provider connection failed");
  process.exit(1);
}

if (mode === "hang") {
  setInterval(() => {}, 10000);
} else if (mode === "malformed_once") {
  if (allArgs.includes("[CORRECTION REQUIRED]")) {
    stepStart();
    textEvent('```json\n{\n  "findings": [{"package": "express", "latest": "4.19.2"}]\n}\n```');
    stepFinish(200, 50);
  } else {
    stepStart();
    textEvent('```json\n{\n  "findings": false\n}\n```');
    stepFinish(100, 30);
  }
} else {
  stepStart();
  textEvent("OpenCode running analysis...\n");
  toolEvent("read_file", { path: "package.json" });
  textEvent('```json\n{\n  "findings": [{"package": "express", "latest": "4.19.2"}]\n}\n```');
  stepFinish(150, 45);
}
