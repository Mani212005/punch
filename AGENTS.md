# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Build and test

- `pnpm typecheck && pnpm lint && pnpm test` - full CI gate; must be green before merging.
- `pnpm --filter @punch/core test` - run only core package tests (fastest for E-step work).
- Live adapter tests (anthropic, gemini) are skipped by default; `jev.live.test.ts` runs against a local server and is always included.
- `pnpm --filter web test:e2e` - Playwright console flow against a real engine server over a fixture run (`apps/web/e2e/engine-harness.mjs`); needs `pnpm build` and `npx playwright install chromium`; not part of the CI gate.

## Architecture

- `plan.md` is the authoritative spec; follow it and the merged shared schemas in `packages/shared/src/`.
- `docs/investigation.md` describes the security investigation system Punch is built around.
- Adversarial critic (E3): `packages/core/src/roles/critic.ts` - runs all 10 `CRITIC_CHALLENGE_IDS` per finding, emits `critic.verdict`, and on rejection provides a `newTask` for the run loop to replan.
- `CriticVerdict` in `packages/shared/src/investigation.ts` is both a Zod schema (value) and a TS type - import as a value when calling `.safeParse()`.
- The run loop (`packages/core/src/run/loop.ts`) routes `requestedTask` from a rejected verdict to a bounded targeted replan; see `replan.triggered` trace event.
- Supply-chain signals (E9): `packages/core/src/supplychain/` (pure `analyzeSupplyChain` over npm metadata; `runSupplyChainPass` attaches `supplyChain` to findings and the ledger); fixtures in `fixtures/npm/supplychain/`.
- Resilience bench (E7): `punch bench <fixture> --resilience` (`apps/engine/src/resilience-bench.ts`, metrics in `packages/core/src/trace/resilience.ts`); engine tests import `@punch/core` from `dist`, so run `pnpm --filter @punch/core build` after core changes.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
