// Starts the real engine HTTP server (the same createEngineServer `punch serve` uses)
// over the recorded takeover fixture with one irreversible tool call appended. The only
// addition over `punch serve` is a per-event delay on the fixture adapters, so a kill and
// an approval can land mid-run deterministically. Used by the Playwright flow.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry } from "../../../packages/core/dist/index.js";
import { createEngineServer } from "../../engine/dist/server/server.js";

// Config validation only checks that the key variables are set; fixture runs never call a provider.
for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"])
  process.env[name] ??= "e2e-not-a-real-key";

const root = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const fixtureSrc = path.join(root, "fixtures/runs/takeover");
const port = Number(process.env.E2E_ENGINE_PORT ?? 4177);
const slowMs = Number(process.env.E2E_SLOW_MS ?? 700);
const origins = (process.env.E2E_WEB_ORIGINS ?? "http://localhost:3100,http://127.0.0.1:3100")
  .split(",")
  .filter(Boolean);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "punch-e2e-"));
const raw = JSON.parse(await fs.readFile(path.join(fixtureSrc, "run.json"), "utf-8"));
for (const rule of raw.http) {
  if (rule.file) rule.file = path.resolve(fixtureSrc, rule.file);
}
raw.agents.executor.s4.calls.push({
  tool: "github_create_issue",
  input: {
    owner: "Mani212005",
    repo: "punch",
    title: "Security: fixture approval probe",
    body: "Dependency: qs 6.5.2\nUpgrade impact: LOW\nSandbox validation: NOT_RUN\nEvidence: ev-1",
  },
});
const fixtureDir = path.join(tmp, "fixture");
await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(path.join(fixtureDir, "run.json"), JSON.stringify(raw), "utf-8");
const configPath = path.join(tmp, "config.json");
await fs.writeFile(configPath, JSON.stringify(raw.config, null, 2), "utf-8");

function slowStream(events, ms) {
  return (async function* () {
    for await (const event of events) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      yield event;
    }
  })();
}
function slowRegistry(inner, ms) {
  const out = new AdapterRegistry();
  for (const kind of inner.kinds()) {
    out.register(kind, (ctx) => {
      const adapter = inner.create(ctx);
      return {
        capabilities: adapter.capabilities,
        test: () => adapter.test(),
        run: (input) => slowStream(adapter.run(input), ms),
      };
    });
  }
  return out;
}

const server = createEngineServer({
  runsDir: path.join(tmp, "runs"),
  sessionsDir: path.join(tmp, "sessions"),
  configPath,
  pairingToken: "e2e-pairing-token",
  viewerToken: "e2e-viewer-token",
  webOrigins: origins,
  transformRunOptions: (options) => ({
    ...options,
    adapters: slowRegistry(options.adapters, slowMs),
  }),
});
const url = await server.listen(port, "127.0.0.1");
console.log(`e2e engine ${url} fixture ${fixtureDir}`);
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
