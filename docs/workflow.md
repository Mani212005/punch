# How Punch works

Punch is a multi-agent security investigation system. You give it a GitHub
repository URL, and it investigates whether known vulnerabilities in that
repo's dependencies actually matter: can the bad code run here, what would
an upgrade break, and does the fix pass real tests. Along the way it
challenges its own conclusions with an adversarial critic, survives agent
failures by handing work to a backup agent, and never files an issue or PR
without a human saying yes.

Everything that does work runs on your machine: the engine, the agents, the
API keys, the tool calls. The public website holds no secrets; it only
renders the run's event stream so you can watch.

## The pipeline

```
repo URL + budget
      |
      v
intake (CLI `punch run` or HTTP POST /runs)
      |
      v
router (Jev) assigns an agent to each role, with backups ranked
      |
      v
planner writes a subtask DAG (ordered steps with dependencies)
      |
      v
investigation roles run: inventory + vulnerability research,
then reachability + upgrade impact per finding, then investigator
      |
      v
adversarial critic attacks each finding (10 challenges)
      |---- reject? planner creates a targeted new task, role re-runs
      |
      v
validator runs the upgrade in an isolated sandbox (baseline vs candidate)
      |
      v
human approval gate (issue or fix PR waits for yes/no)
      |
      v
executor files the issue or opens the fix PR
```

Every box above emits events to an append-only trace (`runs/<id>/trace.jsonl`),
and the web watch board is a pure function of that trace: live view and
replay are the same components fed from SSE or from a file.

## Step by step

### 1. Intake

A run starts with a repository URL and an optional budget (max steps, max
dollars, max wall-clock time). Two doors in, same run loop behind both:

- CLI: `punch run <repo-url>` in `apps/engine/src/run.ts`.
- HTTP: the plain `node:http` server in `apps/engine/src/server/server.ts` exposes
  `/runs`, `/runs/:id`, `/runs/:id/events` (SSE), `/runs/:id/trace`, plus
  kill, chaos, approval, and stop endpoints.

The server binds to localhost and prints a pairing token at startup; the
browser must present it as a bearer header. Two read-only routes accept a
separate viewer token so a judge can watch a live run without any control
access (`apps/engine/src/server/auth.ts`, `serve.ts`).

### 2. Orchestrator and router (Jev)

Punch does not hardcode which model does what. For each role, Jev (the
`jev-latest` model) returns a probability vector over the agents the user
configured, plus a confidence score and a difficulty rating
(`packages/core/src/router/jev.ts`). Policy then applies in this order:
a pinned agent for the role wins first, then a rule matched on difficulty,
then Jev's choice (`packages/core/src/router/policy.ts`).

The full probability vector becomes the slot's standby list: ranked backups
known before anything breaks (`packages/core/src/router/standby.ts`). In
auto mode, confidence below `autoConfirmBelowConfidence` (default 0.6)
pauses for user confirmation; in manual mode the user picks.

The orchestrator itself is a working session (`packages/core/src/
orchestrator/session.ts`): the user-chosen agent in auto or manual mode,
with four engine tools (`packages/core/src/orchestrator/tools.ts`).
`consult_router` returns assignments with standby lists, probabilities,
confidence, and provenance; `start_run` refuses assignments that differ
from the user's manual selection; `get_run_status` and `answer_approval`
are read and acknowledge only. Sessions persist server-side under
`apps/engine/src/server/sessions.ts`.

Jev is also used for two smaller jobs: classifying errors as transient,
permanent, malformed, or not found (`router/classify-error.ts`), and a
pre-check on each claim asking whether the cited evidence supports it.

### 3. Planner and subtask DAG

The planner decomposes the brief into a DAG of subtasks: each has an id, a
role hint, inputs keyed to blackboard entries, dependencies, and an expected
output schema (`packages/core/src/planner.ts`). The DAG is validated (unique
ids, known dependencies, no cycles, every input produced upstream) before
anything runs. The run loop (`packages/core/src/run/loop.ts`) dispatches
subtasks topologically: a subtask starts when its dependencies complete.

### 4. The investigation roles

Each role is a prompt plus a tool set plus a result schema, executed through
one shared runner (`packages/core/src/roles/common.ts`). The tool set per
role is fixed in `toolsForRole`: researchers get the reversible web tools,
the investigator gets blackboard and ledger reads, the critic gets reads
only, and the executor alone gets the gated issue/PR tools.

| Role                                  | Job                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory                             | Lists what is actually installed (manifests, lockfiles, dependency graph)                                                                                  |
| Vulnerability research (`researcher`) | Queries OSV, npm, and the GitHub Advisory database per dependency                                                                                          |
| Reachability                          | Decides exists vs exposed vs exploitable using imports, call sites, routes, and entrypoints from the static analysis tools (`packages/core/src/analysis/`) |
| Upgrade impact (`impact`)             | Rates the fix LOW / MEDIUM / HIGH with detected risks and unknowns, never an invented percentage                                                           |
| Security investigator                 | Synthesizes the four evidence streams into one finding per vulnerability                                                                                   |
| Adversarial critic                    | Tries to prove each finding wrong (next section)                                                                                                           |
| Validator                             | Code, not an agent: installs, builds, and tests the upgrade in a sandbox                                                                                   |
| Executor                              | Renders the report; files the issue or PR only after approval                                                                                              |

### 5. Blackboard

The blackboard (`packages/core/src/blackboard.ts`) is the shared memory:
typed entries keyed by name, each linked to evidence, never overwritten,
with a snapshot per write. Roles read named inputs (for example the
investigator reads `inventory` and `reachability`) and write their outputs
back under a new key. The validator, critic, and executor all read from it.

### 6. Adversarial critic with reject-to-replan

The critic (`packages/core/src/roles/critic.ts`) runs ten fixed challenges
against every finding: fabricated versions, unsupported claims, hallucinated
evidence, missing call-site analysis, unassessed upgrade risk, and more
(`CRITIC_CHALLENGE_IDS` in `packages/shared/src/investigation.ts`). It
returns a verdict of accept or reject. On reject it names a targeted new
task (for example "re-run reachability on package X with route analysis"),
and the run loop sends that task through the planner and back for a second
critique (`replan.triggered` in the trace). If rejections hit the cap, the
slot counts it as a quality failure and a replacement agent takes over.

### 7. Slots with heartbeat and takeover

Every role slot carries one primary model plus up to two backups. The slot
supervisor (`packages/core/src/slots/supervisor.ts`) watches a heartbeat
timestamp updated on every agent event. Silence past `stallAfterMs` (45s for
API agents, 120s for CLI agents) marks the slot stalled; terminal errors,
timeouts, schema failures, operator kills (`punch kill <run> <slot>` or the
Kill button), and critic-rejection caps mark it failed or rejected.

Replacement follows the same authority as routing (pin, fallback chain,
standby list, fresh Jev routing), skipping agents whose provider just failed
(`packages/core/src/slots/replacement.ts`). The replacement receives a
handoff packet: the subtask, the failure reason, the predecessor's inputs,
cached tool results, partial notes, files already inspected, and evidence
already recorded (`packages/core/src/slots/handoff.ts`). Tool results are
cached per run, so identical calls return instantly and are traced with
`cached: true`. After `maxReplacementsPerSlot` (default 2) the slot is
exhausted and the subtask degrades gracefully instead of killing the run.

### 8. Evidence ledger

Every claim in the report is a ledger `Claim`: who authored it, what
evidence backs it, which tools produced that evidence, who verified it, and
its status (`packages/core/src/ledger/`). A claim citing nonexistent
evidence is marked refuted or unsupported, which feeds the critic's
rejection. The ledger view answers "why should I believe this" for every
accepted finding.

### 9. Validation sandbox

The validator is deliberately not an LLM: it copies the repo to a throwaway
directory, runs install/build/test as a baseline, applies the dependency
upgrade, runs them again, and compares (`packages/core/src/sandbox/`).
With Docker available the commands run in a disposable container with CPU,
memory, and time caps and network allowed only for install. Without Docker
the sandbox refuses to run and records `NOT_RUN` (no isolation available);
nothing executes on the host unless the user passes an explicit
`--sandbox=host` opt-in, which is recorded in the trace.

### 10. Human approval gate

Irreversible tools pause the run with `approval.requested` carrying the
exact payload. The CLI (`punch approve` / `punch deny`, `apps/engine/src/
cli-approval.ts`) or the HTTP approval endpoint answers; `--unattended`
auto-denies. A failed or not-run validation never produces an automatic
remediation recommendation: the report says human review is required.

### 11. Fix-PR executor

After approval, the executor (`packages/core/src/remediation/`) files the
GitHub issue or opens the fix PR on a branch (`github-pr.ts`), exactly once,
with validation results and risk attached. A compensation registry can undo
multi-step sequences if a later step fails.

### 12. Trace events

The trace is the audit trail and the UI's data source. Key event kinds
(`packages/shared/src/trace.ts`): `run.started`, `route.decided`,
`plan.created`, `slot.assigned`, `agent.started`, `tool.called`,
`tool.result`, `blackboard.written`, `slot.stalled`, `slot.failed`,
`slot.replacing`, `slot.replaced`, `slot.exhausted`, `critic.verdict`,
`claim.recorded`, `evidence.recorded`, `sandbox.started`, `sandbox.finished`,
`remediation.proposed`, `approval.requested|granted|denied`,
`replan.triggered`, `run.finished`. The bench also derives takeover count
and mean detection-to-takeover time from these events.

### 13. Web watch board and console

The Next.js site (`apps/web/`) has a landing page, a watch board, and a
replay picker. The watch board (`apps/web/app/watch/WatchBoard.tsx`) shows
slot lanes with standby lists, the plan DAG graph, per-role routing
probabilities, per-agent logs, the takeover banner, budget meters, critic
verdicts, the timeline, and (in replay) a scrubber. The trace reducer
(`apps/web/lib/trace/reducer.ts`) turns events into board state, so live
and replay look identical at the same event index. Recorded traces ship
with the site and are offered by the replay picker (`apps/web/lib/trace/catalog.ts`): clean, takeover,
manual, chaos, denial and investigation in `traces/`. The manual, chaos and denial traces are
recorded with `punch run fixtures/runs/<name>` (chaos: `--chaos tool:osv_query_batch:500 --chaos
tool:npm_package_metadata:empty`; denial: `--unattended`), then renamed to `traces/<name>.jsonl`.

The console UI (pairing strip, chat view, Kill buttons, chaos selector,
approval modal) is planned but not merged: there is no `apps/web/app/console`
yet, and the CLI remains the complete control surface. The orchestrator
session it will talk to already exists engine-side (section 2). Likewise `punch serve
--tunnel` for remote viewing is planned; the viewer token exists but the
tunnel flag does not.

## Life of one finding

1. Inventory records `lodash@4.17.20` as installed, with the lockfile lines
   as evidence.
2. Vulnerability research finds CVE-2021-23337 (command injection via
   `template`) in OSV, fixed in 4.17.21, and records the advisory.
3. Reachability searches the repo: `template` is imported in
   `src/render.js`, called from the `/preview` route handler. Verdict:
   REACHABLE, with call-site and route evidence attached.
4. Upgrade impact compares 4.17.20 to 4.17.21: patch semver, no removed
   APIs, test suite covers the used functions. Rating: LOW.
5. The investigator synthesizes this into one finding: reachable, low-risk
   upgrade, recommended action "upgrade to 4.17.21".
6. The critic accepts the reachability evidence but rejects the LOW rating:
   the changelog mentions a changed edge case with no test covering it.
   It requests a new impact task; the planner creates it; the impact agent
   re-runs and returns MEDIUM with the unknown recorded.
7. The second critique accepts. The sandbox upgrades to 4.17.21 in a
   container: baseline 42 passed, candidate 42 passed. PASS.
8. The executor proposes the upgrade with the sandbox result and MEDIUM
   risk. The human approves. The fix PR opens.

If the reachability agent had crashed at step 3, the slot supervisor would
have marked it failed, the standby agent would have resumed with the cached
OSV result and files already inspected, and the finding would still have
completed, with the takeover visible on the watch board.

## What is planned but not merged

- **Investigation role definitions and planner DAG template (E2).** The
  role framework, tool sets, shared schemas, static analysis (E1), critic
  (E3), ledger (E4), sandbox (E5), and executor (E6) are merged; the
  dedicated inventory / reachability / impact / investigator prompts and
  the investigation DAG template are still in progress. The planner prompt
  on main today still describes dependency triage.
- **Console page and remote tunnel viewing.** Viewer-token auth and the
  orchestrator session are merged; the console UI and `serve --tunnel`
  are not.
- **Resilience bench (E7), web report views (E8), supply-chain signals
  (E9, stretch).** Not merged.
