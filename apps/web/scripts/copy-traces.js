import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tracesDir = path.resolve(__dirname, "../../../traces");
const publicTracesDir = path.resolve(__dirname, "../public/traces");

if (fs.existsSync(tracesDir)) {
  fs.mkdirSync(publicTracesDir, { recursive: true });
  const entries = fs.readdirSync(tracesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const srcFile = path.join(tracesDir, entry.name);
      const destFile = path.join(publicTracesDir, entry.name);
      fs.copyFileSync(srcFile, destFile);
      process.stdout.write(`Copied ${entry.name} to public/traces/\n`);
    }
  }
}
