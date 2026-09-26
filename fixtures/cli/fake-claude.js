#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log("2.1.281 (Claude Code)");
  process.exit(0);
}

const mode = process.env.FAKE_CLI_MODE || "success";
const allArgs = args.join(" ");

if (mode === "error") {
  console.error("Error: authentication token expired");
  process.exit(1);
}

if (mode === "hang") {
  setInterval(() => {}, 10000);
} else if (mode === "malformed_once") {
  if (allArgs.includes("[CORRECTION REQUIRED]")) {
    console.log(JSON.stringify({ type: "system", message: "Correction attempt" }));
    console.log(
      JSON.stringify({
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: 'Corrected result:\n```json\n{\n  "findings": [{"package": "lodash", "latest": "4.17.21"}]\n}\n```',
        },
      }),
    );
    console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 200, output_tokens: 50 } }));
  } else {
    console.log(JSON.stringify({ type: "system", message: "Initial attempt" }));
    console.log(
      JSON.stringify({
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: 'Malformed result:\n```json\n{\n  "findings": "invalid_shape_not_array"\n}\n```',
        },
      }),
    );
    console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 100, output_tokens: 30 } }));
  }
} else if (mode === "malformed_always") {
  console.log(
    JSON.stringify({
      type: "content_block_delta",
      delta: {
        type: "text_delta",
        text: 'Always malformed:\n```json\n{\n  "findings": 12345\n}\n```',
      },
    }),
  );
} else {
  // success mode
  console.log(JSON.stringify({ type: "system", message: "Initializing Claude Code" }));
  console.log(
    JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Analyzing repository dependencies...\n" },
    }),
  );
  console.log(JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "npm ls" } }));
  console.log(JSON.stringify({ type: "tool_result", output: "lodash@4.17.20" }));
  console.log(
    JSON.stringify({
      type: "content_block_delta",
      delta: {
        type: "text_delta",
        text: '```json\n{\n  "findings": [{"package": "lodash", "latest": "4.17.21"}]\n}\n```',
      },
    }),
  );
  console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 150, output_tokens: 45 } }));
}
