# Punch

A multi-agent system that plans, delegates across user-configured models, calls real tools, and hands a failed agent's work to a replacement. See [spec.md](spec.md) for the challenge and [plan.md](plan.md) for the build contract. [docs/workflow.md](docs/workflow.md) explains how a run works end to end. Visual design lives in [design/](design/).

## Development

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm typecheck      # turbo: builds workspace deps, then tsc --noEmit per package
pnpm lint           # eslint (flat config)
pnpm test           # vitest per package
pnpm format:check   # prettier
pnpm build
pnpm punch --help   # runs the engine CLI (after pnpm build)
```

`pnpm punch <args>` is shorthand for `pnpm --filter @punch/engine exec node bin/punch.js <args>`. Every subcommand is a stub until its plan.md step lands and exits non-zero with "not implemented yet".

`pnpm install` also installs a pre-commit hook that formats staged files with prettier (CI still enforces `pnpm format:check`).

Copy `.env.example` to `.env` for the provider key names (values are never committed).

## Layout

- `packages/shared`: Zod schemas and types (config, slots, handoff, trace events, API payloads)
- `packages/core`: engine internals (placeholders until steps A1-A11)
- `apps/engine`: the `punch` CLI and, later, the HTTP server
- `apps/web`: Next.js site (added separately)
