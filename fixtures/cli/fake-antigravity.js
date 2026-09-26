#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v") || args.includes("version")) {
  console.log("1.2.11");
  process.exit(0);
}

const mode = process.env.FAKE_CLI_MODE || "success";
const allArgs = args.join(" ");

if (mode === "error") {
  console.error("Error: agy failed to authenticate");
  process.exit(1);
}

if (mode === "hang") {
  setInterval(() => {}, 10000);
} else if (mode === "malformed_once") {
  if (allArgs.includes("[CORRECTION REQUIRED]")) {
    console.log(JSON.stringify({ type: "action", action: "correcting" }));
    console.log(
      JSON.stringify({
        type: "text",
        text: '{\n  "findings": [{"package": "axios", "latest": "1.7.0"}]\n}',
      }),
    );
  } else {
    console.log(JSON.stringify({ type: "action", action: "initial" }));
    console.log(JSON.stringify({ type: "text", text: "not json at all" }));
  }
} else {
  console.log(JSON.stringify({ type: "action", action: "searching" }));
  console.log(JSON.stringify({ type: "text", text: "Antigravity inspecting dependencies...\n" }));
  console.log(
    JSON.stringify({
      type: "text",
      text: '```json\n{\n  "findings": [{"package": "axios", "latest": "1.7.0"}]\n}\n```',
    }),
  );
}
