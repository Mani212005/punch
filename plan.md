# Punch - implementation plan

Punch is a multi-agent system that plans, delegates across user-configured models, calls real tools, and keeps going when an agent fails by handing its work to a replacement agent. Everything that does work runs on the user's machine: the engine, the agents, the API keys, the tool calls. A public website on Vercel explains the system, links to GitHub, and shows the orchestration as it happens: which agent holds which role, what the planner produced, what each agent is doing and saying, and, when one fails, the moment another takes over.

This document is the build contract. Sections 1 to 4 fix the design, section 5 is the ordered work, section 6 is testing, section 7 lists open decisions.

## 0. Assumptions and constraints

- **Language: TypeScript on Node 20+ (ESM), pnpm workspace monorepo.** Engine is a Node server plus CLI. Website is Next.js on Vercel.
- **Local engine, public window.** The engine runs on the user's machine and holds every secret. The website holds no secrets and does no work; it renders an event stream. During a live demo the site connects to the presenter's engine (browsers allow a public HTTPS page to reach `http://localhost`); afterwards, visitors watch recorded runs replayed from trace files bundled with the site. No hosted database or realtime service is required.
- **Reference task: dependency security triage for a GitHub repository.** The engine is general, but this is the task we build tools for, test against, and demo, because its APIs are free, public, and fail realistically, and it has a real irreversible action (filing an issue).
- **Model identifiers are user-entered.** The config carries whatever model strings the user's providers accept, validated by a test call. Examples use `claude-opus-5` and `claude-opus-5-5` because you named them.
- **Jev (`jev-latest`, currently `jev-1.13.0`) decides, code acts.** Jev returns typed answers with probabilities and confidence; thresholds and policy live in code and config.
- **Design system: Bauhaus + Bento + Utilitarian, saved under `design/`.** `design/DESIGN.md` is the visual contract, `design/tokens.css` the values, `design/components.css` the reference implementation, `design/mockups.html` the rendered landing, watch board, and console. Every UI step below builds to that contract.
- **The UI is a pure function of the trace.** Every visual state on the site derives from the run's event log, so the live view and the replay view are the same components fed from SSE or from a file. Nothing is shown that is not also in the audit trail.

## 1. The reference task and the roles

**Input:** a GitHub repository URL and an optional budget.
**Output:** a prioritized remediation report: vulnerable dependencies, fixed versions, breaking-change risk of each upgrade, recommended action. With human approval, filed as a GitHub issue.

| Role | Responsibility | Tools | Must survive |
| --- | --- | --- | --- |
| Orchestrator | Talks to the user, writes the task brief, consults Jev, launches the run, narrates it, relays approvals | `consult_router`, `start_run`, `get_run_status`, `answer_approval` | Its own model failing mid-run (the run is code and continues; narration is taken over) |
| Planner | Decomposes the brief into a subtask DAG with role hints | none (structured output) | Invalid DAG, replan after a permanent failure |
| Researcher | Inventories dependencies, queries vulnerabilities, reads release notes | GitHub contents / releases / compare, OSV query and querybatch, npm registry, GitHub Advisory GraphQL fallback | 404s, OSV 5xx, empty results, rate limits, its own provider dying |
| Executor | Writes the report; with approval, files the issue | blackboard read, `github_create_issue` (irreversible) | Degraded inputs, approval denied, its own provider dying |
| Critic | Checks every claim against evidence and can reject | blackboard and trace read only | Fabricated versions, unsupported claims |

Each role is a **slot** filled by a configured agent. The same model may fill several slots; the distinct-critic rule keeps the critic apart from the executor. Slots are what make takeover possible: when the agent in a slot fails, the slot stays, the agent changes.

## 2. Agent failure and takeover

This is the headline feature and gets its own section. The requirement: when an agent fails for any reason, a replacement agent takes over its work, and a viewer can watch it happen.

### 2.1 Slot state machine

Every role slot in a run moves through these states, and every transition is a trace event:

```
 assigned --> running --> completed
    |            |
    |            +--> stalled  --+
    |            +--> failed   --+--> replacing --> running (replacement) --> ...
    |            +--> rejected --+        |
    |                                     +--> exhausted --> degraded
    +--> (never started: provider check failed) --> replacing
```

- `assigned`: routing chose an agent and, from Jev's probability vector, a ranked **standby list** (every other eligible agent, in descending probability). The standby list is shown on the agent card from the start, so the audience knows who is next before anything breaks.
- `running`: the agent is producing events. A heartbeat timestamp updates on every event.
- `stalled`: no event for `stallAfterMs` (default 45s for API agents, 120s for CLI agents). One nudge is attempted for API agents (a follow-up turn asking for a status or result); CLI agents are not nudged.
- `failed`: the adapter reported a terminal error: authentication failure, repeated 5xx after retries, `refusal`, CLI binary missing, non-zero exit, crash, `maxTurns` reached without a `write_result`, or a result that failed schema validation twice.
- `rejected`: the critic rejected this agent's output the maximum number of times. This counts as a quality failure and triggers replacement with the next standby, preferring a higher cost tier.
- `replacing`: the engine builds a handoff packet, selects a replacement, and starts it. Wall-clock target under 3 seconds so the takeover reads as immediate on screen.
- `exhausted`: no eligible replacement remains, or `maxReplacementsPerSlot` (default 2) was reached. The subtask is written as `degraded` and the run continues.

### 2.2 Detection

| Signal | Source | Classification |
| --- | --- | --- |
| Adapter throws or yields `done(error)` | adapter | Jev classifies the error text as `transient`, `permanent`, `malformed`, or `not_found` (see 3.6); `transient` retries the same agent up to 2 times, everything else fails the slot |
| Heartbeat silence | engine timer | `stalled` |
| Turn cap without result | engine | `failed` (non-transient) |
| Result fails schema twice | engine | `failed` (non-transient) |
| Critic rejections at cap | critic loop | `rejected` |
| Provider health check fails before start | adapter `test()` | `failed` before start |
| Operator kills the agent | UI Kill button or `punch kill <run> <slot>` | `failed` with reason `operator_kill`; this is the demo lever |

### 2.3 Replacement selection

Order of authority, same as initial routing: **pin** for the role is skipped if the pinned agent is the one that failed; then the user's **fallback chain** for the role if configured; then the **standby list** derived from Jev's original probabilities; then a **fresh Jev routing** with the failed agent excluded if the standby list is empty (for example after a config change mid-run).

Additional rules:
- An agent is skipped as replacement if its provider is the one that just failed with an authentication or availability error (a second Anthropic model does not help when the Anthropic key is rejected). Provider-level failures are recorded in a per-run `providerHealth` map and expire after 5 minutes.
- On `rejected` (quality), the replacement must be of equal or higher cost tier when one exists.
- `distinctCritic` still applies: the replacement critic cannot be the executor's agent.
- The replacement's `effort` is bumped one level from the failed attempt when the adapter supports it.

### 2.4 Handoff packet

The replacement does not start from zero. It receives, as its `inputs`:

```ts
Handoff = {
  subtask: Subtask,
  reason: { kind: "stalled"|"failed"|"rejected"|"operator_kill", detail: string },
  predecessor: { agentId, displayName, turnsUsed, usdUsed },
  inputs: Record<string, BlackboardEntry>,       // the same keys the predecessor had
  cachedToolResults: ToolResultSummary[],        // every successful tool call the predecessor made in this subtask
  partialNotes: string | null,                   // the predecessor's last assistant text, if any
  criticFindings: Finding[] | null,              // when reason is "rejected"
  budget: { stepsRemaining, usdRemaining, msRemaining }
}
```

Tool results are cached per run keyed by a hash of tool name and normalized input, so the replacement's identical calls return instantly from cache and are traced as `tool.result` with `cached: true`. This is what makes the takeover cheap and what the UI shows as "resumed with N cached results".

### 2.5 What the viewer sees

1. The agent card in the slot turns amber (`stalled`) or red (`failed`, `rejected`) with the reason in plain words and the classification Jev gave.
2. A takeover banner names the replacement, why it was chosen (pin, chain, standby rank and probability, or fresh routing), and the handoff contents (inputs, cached results, partial notes).
3. The new agent card slides into the slot; the old card moves to a "replaced" stack under it with its cost and turns.
4. The subtask node in the DAG keeps its position and progress; only its assignee label changes.
5. The timeline shows the gap between last heartbeat and takeover, so the audience can see how long detection took.

### 2.6 How to trigger it in a demo

- **Kill button** on the running agent card, or `punch kill <runId> <slot>`. Deterministic and instant; the recommended stage lever.
- **Chaos profiles**: `provider-down:<providerId>` (every call to that provider fails with 503), `stall:<role>` (the adapter stops yielding events), `garbage:<role>` (returns schema-invalid results), `kill-after:<role>:<n>` (the agent dies after n turns). Chaos is set per run from the console or the CLI.
- **Real failure**: revoke or unset a provider key before the run, or stop a CLI's login. Works, but slower to set up on stage.

### 2.7 Limits and honesty

- `maxReplacementsPerSlot` defaults to 2. After that the slot is `exhausted` and the subtask degrades; the report says so.
- Takeover changes the agent, never the subtask contract: the same `output` key with the same schema must be produced.
- The orchestrator's failure is handled the same way for narration, but the run itself never depended on it: the run loop is code.
- CLI agents' internal tool calls are opaque to the cache, so a CLI replacement gets inputs, partial notes, and the reason, but no cached tool results from a CLI predecessor. The banner says "no cached results (previous agent used its own tools)".

## 3. Architecture

```
  Website (Next.js on Vercel, no secrets)          Engine (Node, user's machine)
  +------------------------------------+           +-----------------------------------+
  | /            landing + features    |           | HTTP API (Hono) + SSE             |
  | /watch       live viewer (SSE)     |<--------->| pairing token, CORS               |
  | /watch/:id   replay from trace     |  REST+SSE |                                   |
  | /console     controls when paired  |           | Orchestrator session              |
  +------------------------------------+           |   user-chosen agent + 4 tools     |
                                                   | Router (Jev) + policy             |
                                                   | Run loop: planner -> DAG          |
                                                   |   slots: researcher/executor/critic|
                                                   |   slot supervisor (2.x)           |
                                                   | Adapters: anthropic, gemini,      |
                                                   |   openai-compat, cli/*            |
                                                   | Tool layer: timeout/retry/schema/ |
                                                   |   fallback/cache/chaos/approval   |
                                                   | Blackboard, budget, trace JSONL   |
                                                   +-----------------------------------+
                                                           |              |
                                                     model APIs      local CLIs
```

### 3.1 Monorepo layout

```
punch/
  package.json  pnpm-workspace.yaml  turbo.json  .env.example  README.md
  packages/
    shared/      Zod schemas + types: config, run, slot states, trace events, API payloads
    core/
      orchestrator/   session.ts, tools.ts
      router/         jev.ts, policy.ts, standby.ts, classify-error.ts
      planner.ts
      roles/          researcher.ts, executor.ts, critic.ts
      slots/          supervisor.ts (state machine, heartbeat, detection), handoff.ts, replacement.ts
      adapters/       agent.ts, anthropic.ts, gemini.ts, openai-compat.ts, cli/{claude-code,opencode,antigravity,grok-cli}.ts
      tools/          registry.ts, http.ts, cache.ts, chaos.ts, github.ts, osv.ts, npm.ts, gh-advisory.ts
      blackboard.ts   budget.ts   approval.ts
      trace/          writer.ts, render-md.ts
  apps/
    engine/      Hono server, SSE, config loader, pairing token, CLI `punch`
    web/         Next.js: landing, watch (live + replay), console; components shared by live and replay
  traces/        committed recorded runs used for replay on the site (clean, chaos, takeover, denial)
  fixtures/      recorded provider and tool responses for tests
  runs/          gitignored
```

### 3.2 Config (`~/.punch/config.json`)

```ts
Config = {
  version: 1,
  providers: Provider[],
  agents: AgentEntry[],
  policy: {
    pins: { role: Role, agentId: string }[],
    fallbackChains: { role: Role, agentIds: string[] }[],
    rules: { difficulty: "simple"|"moderate"|"hard", role: Role, agentId: string }[],
    preferences: string,
    distinctCritic: boolean,
    autoConfirmBelowConfidence: number,        // default 0.6
    maxReplacementsPerSlot: number,            // default 2
    stallAfterMs: { api: number, cli: number } // defaults 45000 / 120000
  },
  budgets: { maxSteps: number, maxUsd: number, maxWallClockMs: number },
  defaults: { mode: "auto"|"manual", orchestratorAgentId?: string }
}
Provider =
  | { id, kind: "anthropic"|"gemini"|"xai"|"openai-compatible", baseUrl?, apiKeyEnv: string }
  | { id, kind: "claude-code"|"opencode"|"antigravity"|"grok-cli", binary?: string }
AgentEntry = { id, displayName, providerId, model, costTier: "low"|"medium"|"high", roles: Role[], strengths: string, pricing? }
Role = "orchestrator"|"planner"|"researcher"|"executor"|"critic"
```

Secrets are referenced by environment variable name only. `punch config validate` and `punch config test` (one minimal call per agent, one check per CLI) are the first things a new user runs. A console form over this schema exists but is a later step; editing the file is the primary path.

### 3.3 Adapter interface

```ts
interface AgentAdapter {
  capabilities: { toolCalling: boolean, structuredOutput: boolean, streaming: boolean, effort: boolean }
  run(input: { system, task, inputs, tools: ToolSpec[], resultSchema, effort, maxTurns, signal }): AsyncIterable<AgentEvent>
  test(): Promise<{ ok: boolean, detail: string }>
}
```

- `anthropic`: `@anthropic-ai/sdk` tool runner with `betaZodTool`, streaming, `max_iterations`, adaptive thinking, `output_config.effort`, server-side `fallbacks: "default"`, `refusal` handled.
- `gemini`: `@google/genai`, function declarations from the shared JSON Schema, manual loop.
- `openai-compat`: `openai` SDK at a `baseUrl` for any compatible server. Not in the initial build order because no such subscription is held today; it exists so a future provider needs no new adapter.
- `cli/*` (Claude Code, OpenCode, Antigravity first; Grok CLI only if a subscription appears): spawn in an isolated workdir with a prompt file; parse streamed JSON where the CLI provides it; validate the final text against `resultSchema` with one correction round; `test()` runs the CLI's version or auth-status command. Launch shapes come from firstmate's verified `harness-adapters` reference. `toolCalling: false`, so these agents cannot be the orchestrator and their internal tool calls are traced as `agent.opaque_output`. Irreversible actions remain gated because only engine tools can perform them.

Every adapter yields a heartbeat-bearing event stream; the slot supervisor consumes it.

### 3.4 Orchestrator session

The user-chosen agent with four engine tools. `consult_router` returns assignments, standby lists, probabilities, confidence, difficulty, and provenance. `start_run` refuses assignments that differ from the user's manual selection. `get_run_status` and `answer_approval` are read and acknowledge only. Sessions persist under `~/.punch/sessions/`.

### 3.5 Router: Jev decides, policy applies

One Jev request per routing, questions in parallel over one state:

State: `{ task: { brief, expectedOutputs, irreversibleActionsPossible }, agents: [{ id, displayName, provider, costTier, roles, strengths }], preferences, budget }` with `agents` filtered to those allowed for the role.

| id | primitive | asks | options |
| --- | --- | --- | --- |
| `difficulty` | Score | How demanding is this task? | `simple`, `moderate`, `hard` with concrete descriptions |
| `planner`, `researcher`, `executor`, `critic` | Choice each | Which agent should fill this role, given each agent's stated strengths, cost tier, and the user's preferences? | one option per eligible agent, description = user's `strengths` + cost tier + provider |
| `needs_external_data` | Noul | Does this task need data not in the request? | true / false |
| `is_sensitive` | Noul | Would completing it change anything outside this program? | true / false |

Authority per role: pin > rule matched on `difficulty` > Jev choice. The full probability vector for each role becomes that slot's standby list (2.1). Per subtask, a second small routing picks `assignee` among `researcher`, `executor`, `none_needed`, `human`, plus a `complexity` Score that sets `effort`. In auto mode, confidence below `autoConfirmBelowConfidence` pauses for confirmation; in manual mode confidence is displayed only.

Two further Jev uses: **error classification** (3.6) and **critic pre-check** (one Noul per claim, "is this claim supported by the cited evidence?").

### 3.6 Tool layer, recovery ladder

1. Code: per-call timeout, bounded backoff on 429 / 5xx / network, `Retry-After`, Zod validation; wrong-shape 200 is `malformed`.
2. Error classification by Jev: `transient` (retry), `permanent` (fall back), `malformed` (retry once, then fall back), `not_found` (degrade).
3. Fallback chains: OSV -> GitHub Advisory; npm -> `unknown`; releases -> `CHANGELOG.md` -> none. Traced as `fallback.used`.
4. Tool result cache per run (feeds handoff).
5. Degradation: `status: "degraded"` entries the executor must surface as unknown.
6. **Agent takeover** (section 2).
7. Replan: one, on a permanent failure with dependents.
8. Compensation: undo registry for multi-step irreversible sequences (PR stretch goal).
9. Chaos: the profiles in 2.6 plus per-tool `500`, `hang`, `truncate`, `empty`.

### 3.7 Approval gate, budgets, blackboard, trace

- **Approval**: irreversible tools pause the run with `approval.requested` and the exact payload; the console modal or `punch approve|deny` answers; no auto-approve flag; `--unattended` auto-denies.
- **Budgets**: `maxSteps`, `maxUsd` from measured usage and per-agent pricing (CLI agents: steps and time only, labeled "cost not metered"), `maxWallClockMs`; abort via `AbortSignal`; one wrap-up executor turn on a reserved slice.
- **Blackboard**: typed, evidence-linked, never overwritten, snapshot per write.
- **Trace** `runs/<id>/trace.jsonl`, append-only. Event kinds: `run.started`, `route.decided`, `route.skipped`, `plan.created`, `slot.assigned`, `agent.started`, `agent.heartbeat` (sampled), `agent.text`, `agent.opaque_output`, `tool.called`, `tool.result` (with `cached`), `tool.retry`, `fallback.used`, `blackboard.written`, `slot.stalled`, `slot.failed`, `slot.rejected`, `slot.replacing` (handoff summary, selection provenance), `slot.replaced`, `slot.exhausted`, `critic.verdict`, `approval.requested|granted|denied`, `budget.checked`, `replan.triggered`, `compensation.ran`, `run.finished`.

### 3.8 Engine API

| Method | Path | Purpose |
| --- | --- | --- |
| GET / PUT | `/config` | Read and validate-write the config |
| POST | `/agents/:id/test`, `/providers/:id/check` | Health checks |
| POST / GET | `/sessions`, `/sessions/:id` | Orchestrator sessions |
| POST | `/sessions/:id/messages` | User message; reply streams on SSE |
| GET | `/sessions/:id/events`, `/runs/:id/events` | SSE streams (session narration; run trace) |
| POST | `/runs/:id/assignments` | Manual selections and confirmations |
| POST | `/runs/:id/approvals/:approvalId` | Approve or deny |
| POST | `/runs/:id/slots/:role/kill` | Operator kill (demo lever) |
| POST | `/runs/:id/chaos` | Set chaos profile for a run before start |
| POST | `/runs/:id/stop` | Abort |
| GET | `/runs`, `/runs/:id`, `/runs/:id/trace` | History and raw trace |

Security: binds to localhost, prints a pairing token at startup, requires it as a bearer header, CORS limited to the configured web origins. Read-only viewing (`/runs/:id/events`, `/runs/:id/trace`) is exposed with a separate viewer token so judges on their own devices can watch a live run through a tunnel without control access. `punch serve --tunnel` starts a quick tunnel and prints the viewer URL; this is a phase C deliverable, not a stretch goal.

## 4. The website

Public, static-first, no secrets, deployed on Vercel from `apps/web`. Visual design follows `design/DESIGN.md` exactly: warm paper canvas, 2px ink borders, a 12-column bento grid, mono uppercase labels, and three primaries with one meaning each (blue running, red failed, yellow attention). Geometry carries state: circle running, square done, triangle attention, rotated square failed.

### 4.1 Landing (`/`)

- Hero: one sentence on what Punch does, a Watch button that opens a replay of the recorded takeover run, and a GitHub button.
- How it works: the architecture diagram from section 3, animated in three steps (plan, delegate, recover).
- Features, each mapped to a spec requirement and each linking to the moment in a recorded trace that proves it: planning and delegation, real tools with real failure handling, agent takeover, audit trail, budgets and stopping, human approval.
- Run it locally: install, `punch config test`, `punch serve`, open `/console`.
- GitHub link in the header and footer.

### 4.2 Watch (`/watch` live, `/watch/:traceId` replay)

The orchestration board. Same components for live and replay; the only difference is the event source (SSE from a paired engine, a viewer-token tunnel URL for remote judges, or a JSONL file from `traces/`).

- **Slot lanes**: one lane per role. Each holds the current agent card (display name, provider, model, state color, turns, tokens, cost, elapsed, heartbeat age), the standby list, and a stack of replaced agents.
- **Plan graph**: the subtask DAG with status colors, current assignee labels, and dependency edges; clicking a node opens its inputs, output, evidence, and the agent's log for that subtask.
- **Routing card**: per-role probability bars, confidence, and provenance (pin, rule, Jev, chain, standby, fresh routing).
- **Agent logs**: per-agent tabs streaming text, tool calls with status, latency, retry count, fallback used, cached flag; opaque output for CLI agents.
- **Takeover banner** as in 2.5.
- **Approval, budget meter, critic verdicts, final report** panels.
- **Timeline**: Gantt of agents and tool calls; in replay, a scrubber with 1x / 4x / step controls.
- **Replay picker**: the committed traces (clean auto run, manual run on a different agent mix, chaos with tool fallbacks, agent takeover, denied approval), plus "load a trace file" for any local run.

### 4.3 Console (`/console`)

Appears only when paired with an engine (engine URL and token entered on the page, stored in the browser). Contains the orchestrator picker, mode toggle, task input, the chat thread with the orchestrator's narration, the Kill button per slot, chaos profile selector, approval modal, and a link to the config file with a validate button. A config form over the schema is a later step. The CLI remains a complete alternative for every control action so a demo never depends on the browser.

### 4.4 Deployment

Vercel project rooted at `apps/web`, Next.js preset, pnpm. Build copies `traces/*.jsonl` into `public/traces/`. Only build-time variable: `NEXT_PUBLIC_DEFAULT_ENGINE_URL` (`http://localhost:4141`). Preview deployments per PR, production from `main`.

## 5. Work breakdown

Ordered so the engine works end to end first, takeover lands before any UI, and the website consumes a trace format that is already stable. Each step is one PR with a "done when".

### Phase A - Engine core on one provider, CLI only

- **A0 Scaffold.** Workspace, packages, engine CLI stubs, strict TS, vitest, eslint, prettier, `.env.example`. Done when typecheck, tests, and `punch --help` pass from a clean clone.
- **A1 Trace and budget.** Event union in `shared` including slot events, JSONL writer with redaction, meter. Done when every event round-trips and each limit fires.
- **A2 Config.** Schema, loader, env presence check, hot reload, `punch config validate|test`. Done when malformed config fails with field-level messages.
- **A3 Tool layer.** HTTP core, chaos hook, GitHub / OSV / npm / Advisory clients, result cache, fixtures. Done when retry, no-retry, malformed, timeout, fallback, and cache-hit tests pass.
- **A4 Blackboard.**
- **A5 Anthropic adapter** with heartbeat events, usage, `write_result`, abort, effort. Done when a fixture subtask completes and a chaos run degrades instead of crashing.
- **A6 Router on Jev** with policy, standby lists, error classification. Done when a 20-case labeled fixture asserts outcomes and one live call confirms the SDK shape.
- **A7 Planner, roles, critic** with pre-check and rejection cap.
- **A8 Run loop** with slots as first-class objects: topological dispatch, stopping conditions, replan, wrap-up. Done when `punch run <fixture>` completes offline and every tool chaos profile completes degraded.
- **A9 Slot supervisor and takeover.** State machine, heartbeat and stall detection, failure classification, replacement selection (pin, chain, standby, fresh), handoff packet with cached tool results, limits, `punch kill`. Done when: `kill` mid-subtask produces `slot.failed` -> `slot.replacing` -> `slot.replaced` and the subtask completes on the replacement with cached results reused; `provider-down` skips same-provider standbys; `stall` triggers after the configured silence; two replacements then `slot.exhausted` and a degraded key; a critic `rejected` picks an equal or higher tier.
- **A10 Approval in the CLI** and live issue creation on a repo you own.
- **A11 Trace render and bench**, including takeover count and mean detection-to-takeover time as bench metrics.

### Phase B - More providers (order follows the subscriptions actually held)

- **B1 Gemini adapter** (free-tier key available). **B2 CLI adapters**: Claude Code, OpenCode (free), Antigravity, with `test()` and opaque-output tracing; Grok CLI is deferred until a subscription exists. **B3 Cross-provider takeover test:** kill an Anthropic researcher and watch a Gemini or CLI standby finish the subtask; `provider-down:anthropic` must route to a non-Anthropic standby. **B4 Per-subtask effort routing.** **B5 (only if a key appears) OpenAI-compatible adapter** for xAI or any compatible endpoint.

### Phase C - Engine API and website

- **C1 Engine HTTP API** with SSE, pairing token, viewer token, CORS, session persistence, kill and chaos endpoints. Done when a full fixture run is driven through HTTP only.
- **C1b Remote live viewing.** `punch serve --tunnel` (quick tunnel), viewer-token-only routes, and a Watch page that accepts a viewer URL. Done when a second device on a different network watches a live run, including a takeover, and cannot kill, approve, or stop.
- **C2 Orchestrator session** and tools; manual-mode enforcement.
- **C3 Web scaffold**: Next.js, `design/tokens.css` and `design/components.css` loaded globally, Space Grotesk and JetBrains Mono through `next/font`, event-source abstraction (SSE, viewer URL, or file), trace reducer that turns events into board state, replay scrubber. Done when a committed takeover trace renders as a board with no engine present.
- **C4 Watch page** built to `design/mockups.html`: bento of run and budget tiles, takeover banner, slot tiles, plan graph, routing card, agent logs, timeline, replay picker. Done when live and replay of the same run look identical frame for frame at the same event index.
- **C5 Console** built to `design/mockups.html`: pairing strip, controls tile, live slots with Kill, conversation tile, approval tile, manual routing tile. Done when the reference task runs from the browser in both modes with one operator kill and one denial.
- **C6 Landing page** built to `design/mockups.html`: hero and GitHub tiles, the three geometric how-it-works tiles, six feature tiles linked to trace moments, run-it-locally and where-things-run tiles.
- **C7 Record the demo traces** into `traces/` (clean auto, manual mix, tool chaos, takeover, denial) and wire the replay picker. **C8 Vercel deployment** with previews. Done when the production URL replays the takeover run without an engine and drives a local engine when paired.

### Phase D - Hardening and demo

- **D1** Bench on three public repos with and without chaos; tune stall timeouts, thresholds, and turn caps from traces.
- **D2** README and demo script: clean auto run, then kill the researcher live and narrate the takeover, then a manual run on a different agent mix, then a denied approval. The live approval test files one issue on `https://github.com/Mani212005/punch`. Rehearse with the CLI as the fallback control surface.
- **D3** Stretch: PR instead of issue with compensation; config form in the console; Docker image for a remote engine.

## 6. Testing

- **Unit** (no network): tools, cache, router policy and standby derivation, slot state machine (every transition, timers under fake clocks), handoff builder, budget, blackboard, config, trace round-trip, adapter loops with mocked clients.
- **Fixture integration** (no network): whole runs from recorded responses, assertions on trace events.
- **Chaos and takeover integration**: every profile in 2.6; assert the exact slot event sequence, cached-result reuse, provider exclusion, exhaustion, and completion.
- **HTTP integration**: full run and a kill through the API.
- **Web**: reducer tests (events in, board state out, including takeover), component tests for card states and the banner, one Playwright flow: pair, run, kill, watch takeover, deny approval.
- **Live smoke** (opt-in, spends money): one planner call, one Jev routing, one run per configured adapter, one cross-provider takeover, one denial.
- **Bench**: measurement for the README, including completion rate under the takeover chaos profile.

## 7. Decisions recorded (2026-09-26)

All seven were answered in the Lavish review and the plan above reflects them.

1. **Website scope:** Landing, Watch, and a Console that appears only when paired to the local engine.
2. **Live viewing:** judges watch live from their own devices, so the viewer token and quick tunnel are phase C (step C1b), not stretch.
3. **Providers, in build order:** Anthropic API, Google Gemini API (free tier), Claude Code CLI, OpenCode CLI (free), Antigravity CLI. No xAI or Grok CLI subscription; the OpenAI-compatible adapter and Grok CLI adapter wait until a key exists.
4. **Takeover defaults:** 2 replacements per slot, 45 second API stall, 120 second CLI stall.
5. **Reference task:** dependency security triage.
6. **Jev's remit:** role and subtask routing, standby lists, error classification, and critic pre-check.
7. **Demo repo for the live approval test:** `https://github.com/Mani212005/punch`.

The plan is approved as written. Next action, when the captain gives the word: brief a worker on phase A, starting at A0.
