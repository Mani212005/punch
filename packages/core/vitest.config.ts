import { defineConfig, defineProject, defaultExclude } from "vitest/config";

// The sandbox's real-process tests (real npm installs, real Docker) share the
// machine with everything else in a plain `vitest run` and starve
// timing-sensitive unit tests under load. Two projects keep them apart: `pnpm
// test` runs the unit suite alone first (fast and deterministic), then the
// integration project runs the heavy tests serially with a generous timeout.
export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: "unit",
          exclude: [...defaultExclude, "src/sandbox/validate-host.test.ts"],
        },
      }),
      defineProject({
        test: {
          name: "integration",
          include: ["src/sandbox/validate-host.test.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 180_000,
        },
      }),
    ],
  },
});
