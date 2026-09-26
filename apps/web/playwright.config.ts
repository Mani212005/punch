import { defineConfig } from "@playwright/test";

// One Playwright flow against the real engine server over a recorded fixture run
// (plan.md section 6). Run with `pnpm --filter web test:e2e`; needs `pnpm build` first.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://localhost:3100" },
  webServer: [
    {
      command: "node e2e/engine-harness.mjs",
      url: "http://127.0.0.1:4177/runs",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm exec next dev -p 3100",
      url: "http://localhost:3100/console",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
