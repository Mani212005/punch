import type { TraceEvent } from "@punch/shared";

/**
 * Renders any run trace to a readable markdown audit (plan.md A11):
 * which agent did what, with which inputs, why it was chosen (routing
 * provenance), tool calls with status/latency/retries/fallbacks/cache,
 * slot transitions and takeovers, critic verdicts, approvals, budget,
 * and the final report.
 */
export function renderTraceMarkdown(events: TraceEvent[]): string {
  const lines: string[] = [];
  const runId = events[0]?.runId ?? "unknown";
  const started = events.find((e) => e.kind === "run.started");
  let finished: Extract<TraceEvent, { kind: "run.finished" }> | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "run.finished") {
      finished = e;
      break;
    }
  }

  lines.push(`# Punch run audit - ${runId}`);
  lines.push("");
  lines.push(...renderOverview(events, started));
  lines.push("");
  lines.push(...renderRouting(events));
  lines.push("");
  lines.push(...renderPlan(events));
  lines.push("");
  lines.push(...renderAgentActivity(events));
  lines.push("");
  lines.push(...renderToolCalls(events));
  lines.push("");
  lines.push(...renderSlots(events));
  lines.push("");
  lines.push(...renderCritic(events));
  lines.push("");
  lines.push(...renderClaims(events));
  lines.push("");
  lines.push(...renderSandbox(events));
  lines.push("");
  lines.push(...renderApprovals(events));
  lines.push("");
  lines.push(...renderBudget(events));
  lines.push("");
  lines.push(...renderOutcome(events, finished));
  lines.push("");
  return lines.join("\n");
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine;
}

function fmtJson(value: unknown, max = 300): string {
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return truncate(String(value), max);
  }
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "n/a";
  return `${ms}ms`;
}

/**
 * A markdown table with padded cells, so the emitted audit is stable under
 * `prettier --write` (the repo formats staged `*.md` on commit): the
 * golden-file test compares the render byte for byte.
 */
export function markdownTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => pad(c, widths[i] ?? c.length)).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`,
    ...rows.map((r) => line(r)),
  ];
}

function renderOverview(
  events: TraceEvent[],
  started: Extract<TraceEvent, { kind: "run.started" }> | undefined,
): string[] {
  const out = ["## Run overview"];
  if (!started) {
    out.push("", "No `run.started` event in this trace.");
    return out;
  }
  out.push(
    "",
    `- Repository: ${esc(started.task.repoUrl)}`,
    `- Mode: ${started.mode}`,
    `- Budgets: steps ${started.budgets.maxSteps}, USD ${started.budgets.maxUsd}, wall-clock ${started.budgets.maxWallClockMs}ms`,
    `- Chaos: ${started.chaos.length ? started.chaos.map(esc).join(", ") : "none"}`,
    `- Events: ${events.length}`,
  );
  if (started.task.brief) out.push(`- Brief: ${esc(truncate(started.task.brief, 500))}`);
  if (started.task.budgetUsd !== undefined)
    out.push(`- Run budget override: $${started.task.budgetUsd}`);
  if (started.orchestratorAgentId) out.push(`- Orchestrator: ${esc(started.orchestratorAgentId)}`);
  return out;
}

function renderRouting(events: TraceEvent[]): string[] {
  const out = ["## Routing - why each agent was chosen"];
  const decided = events.filter((e) => e.kind === "route.decided");
  const skipped = events.filter((e) => e.kind === "route.skipped");
  const assigned = events.filter((e) => e.kind === "slot.assigned");
  if (decided.length === 0 && skipped.length === 0) {
    out.push("", "No routing events.");
    return out;
  }
  if (decided.length > 0) {
    out.push(
      "",
      ...markdownTable(
        ["Role", "Agent", "Provenance", "Confidence", "Probabilities", "Subtask"],
        decided.map((e) => {
          const probs = e.probabilities
            .map((p) => `${p.agentId} ${p.probability.toFixed(2)}`)
            .join(", ");
          return [
            esc(e.role),
            esc(e.agentId),
            esc(e.provenance),
            `${e.confidence.toFixed(2)}${e.difficulty ? ` (${e.difficulty})` : ""}`,
            esc(probs),
            esc(e.subtaskId ?? "-"),
          ];
        }),
      ),
    );
  }
  if (assigned.length > 0) {
    out.push("", "Slot assignments (standby in rank order):", "");
    for (const e of assigned) {
      const standby = e.standby.length
        ? e.standby.map((s) => `${s.agentId} (${s.probability.toFixed(2)})`).join(", ")
        : "none";
      out.push(`- ${e.role} -> ${e.agentId} via ${e.provenance}; standby: ${standby}`);
    }
  }
  for (const e of skipped) {
    out.push(`- route.skipped ${e.role}: ${truncate(e.reason, 200)}`);
  }
  return out;
}

function renderPlan(events: TraceEvent[]): string[] {
  const out = ["## Plan - subtask DAG", ""];
  const created = events.filter((e) => e.kind === "plan.created");
  if (created.length === 0) {
    out.push("", "No `plan.created` event.");
    return out;
  }
  const latest = created[created.length - 1]!;
  for (const s of latest.subtasks) {
    out.push(
      `- ${s.id}: ${truncate(s.title, 120)} (hint: ${s.roleHint}${s.assignee ? `, assignee: ${s.assignee}` : ""}${s.effort ? `, effort: ${s.effort}` : ""})`,
      `  - depends on: ${s.dependsOn.length ? s.dependsOn.join(", ") : "none"}; produces: ${s.output.key}; inputs: ${s.inputKeys.length ? s.inputKeys.join(", ") : "none"}`,
      `  - ${truncate(s.description, 300)}`,
    );
  }
  const replans = events.filter((e) => e.kind === "replan.triggered");
  for (const e of replans) {
    out.push(`- replan triggered by ${e.subtaskId}: ${truncate(e.reason, 300)}`);
  }
  return out;
}

function renderAgentActivity(events: TraceEvent[]): string[] {
  const out = ["## Agents - who did what, with which inputs"];
  const starts = events.filter((e) => e.kind === "agent.started");
  if (starts.length === 0) {
    out.push("", "No agent activity.");
    return out;
  }
  const texts = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind === "agent.text" || e.kind === "agent.opaque_output") {
      const key = `${e.role}/${e.agentId}/${e.subtaskId ?? "-"}`;
      const arr = texts.get(key) ?? [];
      arr.push(`${e.kind === "agent.opaque_output" ? "[opaque] " : ""}${truncate(e.text, 200)}`);
      texts.set(key, arr);
    }
  }
  out.push(
    "",
    ...markdownTable(
      ["Agent", "Role", "Subtask", "Attempt", "Effort", "Notes"],
      starts.map((e) => {
        const key = `${e.role}/${e.agentId}/${e.subtaskId ?? "-"}`;
        const notes = (texts.get(key) ?? []).slice(0, 2).join(" / ");
        return [
          esc(e.agentId),
          esc(e.role),
          esc(e.subtaskId ?? "-"),
          String(e.attempt),
          esc(e.effort ?? "-"),
          esc(notes || "-"),
        ];
      }),
    ),
  );
  const heartbeats = events.filter((e) => e.kind === "agent.heartbeat").length;
  out.push("", `Heartbeats traced: ${heartbeats}.`);
  return out;
}

function renderToolCalls(events: TraceEvent[]): string[] {
  const out = ["## Tool calls - status, latency, retries, fallbacks, cache"];
  const called = events.filter((e) => e.kind === "tool.called");
  const results = new Map<string, Extract<TraceEvent, { kind: "tool.result" }>>();
  for (const e of events) {
    if (e.kind === "tool.result") results.set(e.callId, e);
  }
  const retries = new Map<string, Extract<TraceEvent, { kind: "tool.retry" }>[]>();
  for (const e of events) {
    if (e.kind === "tool.retry") {
      const arr = retries.get(e.callId) ?? [];
      arr.push(e);
      retries.set(e.callId, arr);
    }
  }
  const fallbacks = events.filter((e) => e.kind === "fallback.used");
  if (called.length === 0) {
    out.push("", "No tool calls.");
  } else {
    const rows: string[][] = [];
    const pushResultRow = (
      callId: string,
      agent: string,
      tool: string,
      status: string,
      cached: string,
      latency: string,
      retryCount: number,
      detail: string,
    ): void => {
      rows.push([
        esc(callId),
        esc(agent),
        esc(tool),
        status,
        cached,
        latency,
        String(retryCount),
        esc(detail),
      ]);
    };
    for (const c of called) {
      const r = results.get(c.callId);
      const retryCount = retries.get(c.callId)?.length ?? r?.retries ?? 0;
      const status = !r ? "no result" : r.ok ? "ok" : "failed";
      const detail = !r
        ? `input ${fmtJson(c.input, 160)}`
        : r.ok
          ? fmtJson(r.output, 160)
          : truncate(r.error ?? "error", 160);
      pushResultRow(
        c.callId,
        `${c.agentId} (${c.role}${c.subtaskId ? `/${c.subtaskId}` : ""})`,
        c.tool,
        status,
        r ? (r.cached ? "yes" : "no") : "-",
        r ? fmtMs(r.latencyMs) : "-",
        retryCount,
        detail,
      );
    }
    const unanswered = [...results.values()].filter(
      (r) => !called.some((c) => c.callId === r.callId),
    );
    for (const r of unanswered) {
      pushResultRow(
        r.callId,
        "-",
        r.tool,
        r.ok ? "ok" : "failed",
        r.cached ? "yes" : "no",
        fmtMs(r.latencyMs),
        r.retries,
        r.ok ? fmtJson(r.output, 160) : truncate(r.error ?? "error", 160),
      );
    }
    out.push(
      "",
      ...markdownTable(
        ["Call", "Agent", "Tool", "Status", "Cached", "Latency", "Retries", "Detail"],
        rows,
      ),
    );
  }
  const retryEvents = events.filter((e) => e.kind === "tool.retry");
  if (retryEvents.length > 0) {
    out.push("", "Retries:", "");
    for (const e of retryEvents) {
      out.push(
        `- ${e.callId} ${e.tool} attempt ${e.attempt} after ${e.delayMs}ms (${e.errorClass}): ${truncate(e.error, 200)}`,
      );
    }
  }
  if (fallbacks.length > 0) {
    out.push("", "Fallbacks:", "");
    for (const e of fallbacks) {
      out.push(`- ${e.tool}: ${e.from} -> ${e.to}: ${truncate(e.reason, 200)}`);
    }
  }
  const cachedCount = [...results.values()].filter((r) => r.cached).length;
  out.push("", `Cache hits: ${cachedCount} of ${results.size} results.`);
  return out;
}

function renderSlots(events: TraceEvent[]): string[] {
  const out = ["## Slots - transitions and takeovers", ""];
  const kinds = [
    "slot.stalled",
    "slot.failed",
    "slot.rejected",
    "slot.replacing",
    "slot.replaced",
    "slot.exhausted",
  ] as const;
  const relevant = events.filter((e) => (kinds as readonly string[]).includes(e.kind));
  if (relevant.length === 0) {
    out.push("No slot transitions: no stall, failure, rejection, takeover, or exhaustion.");
    return out;
  }
  for (const e of relevant) {
    switch (e.kind) {
      case "slot.stalled":
        out.push(
          `- stalled ${e.role}/${e.agentId}${e.subtaskId ? ` on ${e.subtaskId}` : ""}: silent ${fmtMs(e.silentMs)}${e.nudged ? " (nudged)" : ""}`,
        );
        break;
      case "slot.failed":
        out.push(
          `- failed ${e.role}/${e.agentId}${e.subtaskId ? ` on ${e.subtaskId}` : ""}: ${e.reason.kind} - ${truncate(e.reason.detail, 250)}${e.classification ? ` [${e.classification}]` : ""}`,
        );
        break;
      case "slot.rejected":
        out.push(
          `- rejected ${e.role}/${e.agentId}${e.subtaskId ? ` on ${e.subtaskId}` : ""}: ${e.rejections} rejection(s)`,
        );
        for (const f of e.findings) {
          out.push(`  - claim "${truncate(f.claim, 140)}": ${truncate(f.problem, 200)}`);
        }
        break;
      case "slot.replacing": {
        const skipped = e.selection.skipped.length
          ? `; skipped: ${e.selection.skipped.map((s) => `${s.agentId} (${s.reason})`).join(", ")}`
          : "";
        out.push(
          `- takeover ${e.role}: ${e.failedAgentId} -> ${e.replacementAgentId} (${e.reason.kind}: ${truncate(e.reason.detail, 200)})`,
        );
        out.push(
          `  - chosen via ${e.selection.provenance}${e.selection.rank ? `, standby rank ${e.selection.rank}` : ""}${e.selection.probability !== undefined ? ` (p=${e.selection.probability.toFixed(2)})` : ""}${skipped}`,
        );
        out.push(
          `  - handoff: inputs [${e.handoff.inputKeys.join(", ") || "none"}], ${e.handoff.cachedResultCount} cached result(s)${e.handoff.filesInspectedCount !== undefined ? `, ${e.handoff.filesInspectedCount} file(s)` : ""}${e.handoff.evidenceRecordCount !== undefined ? `, ${e.handoff.evidenceRecordCount} evidence record(s)` : ""}; detection ${fmtMs(e.detectionMs)}`,
        );
        if (e.handoff.partialNotes)
          out.push(`  - partial notes: ${truncate(e.handoff.partialNotes, 250)}`);
        break;
      }
      case "slot.replaced":
        out.push(
          `- replaced ${e.role}: ${e.failedAgentId} -> ${e.replacementAgentId} in ${fmtMs(e.takeoverMs)}${e.subtaskId ? ` (${e.subtaskId})` : ""}`,
        );
        break;
      case "slot.exhausted":
        out.push(
          `- exhausted ${e.role}${e.subtaskId ? ` on ${e.subtaskId}` : ""}: ${truncate(e.reason, 250)}${e.degradedKey ? ` (degraded key: ${e.degradedKey})` : ""}`,
        );
        break;
      default:
        break;
    }
  }
  const takeovers = events.filter((e) => e.kind === "slot.replaced").length;
  const detections = events
    .filter((e) => e.kind === "slot.replacing" && e.detectionMs !== undefined)
    .map((e) => (e.kind === "slot.replacing" ? e.detectionMs! : 0));
  const mean =
    detections.length > 0
      ? Math.round(detections.reduce((a, b) => a + b, 0) / detections.length)
      : null;
  out.push(
    "",
    `Takeovers: ${takeovers}; mean detection-to-takeover time: ${mean === null ? "n/a (no measured detection gaps)" : `${mean}ms over ${detections.length} takeover(s)`}.`,
  );
  return out;
}

function renderCritic(events: TraceEvent[]): string[] {
  const out = ["## Critic verdicts"];
  const verdicts = events.filter((e) => e.kind === "critic.verdict");
  if (verdicts.length === 0) {
    out.push("", "No critic verdicts.");
    return out;
  }
  out.push(
    "",
    ...markdownTable(
      ["Subtask", "Critic", "Verdict", "Attempt", "Findings"],
      verdicts.map((e) => {
        const findings = e.findings.length
          ? e.findings.map((f) => truncate(`${f.claim}: ${f.problem}`, 120)).join(" / ")
          : "-";
        return [esc(e.subtaskId), esc(e.agentId), e.verdict, String(e.attempt), esc(findings)];
      }),
    ),
  );
  return out;
}

function renderClaims(events: TraceEvent[]): string[] {
  const out = ["## Evidence ledger - claims and evidence", ""];
  const recorded = events.filter((e) => e.kind === "claim.recorded");
  const verified = events.filter((e) => e.kind === "claim.verified");
  const refuted = events.filter((e) => e.kind === "claim.refuted");
  const evidence = events.filter((e) => e.kind === "evidence.recorded");
  if (recorded.length === 0 && evidence.length === 0) {
    out.push("No ledger claims or evidence in this trace.");
    return out;
  }
  for (const e of recorded) {
    out.push(
      `- claim ${e.claim.id} [${e.claim.kind}/${e.claim.status}]: ${truncate(e.claim.text, 220)}`,
    );
    out.push(
      `  - by ${e.claim.author.role}${e.claim.author.agentId ? `/${e.claim.author.agentId}` : ""} on finding ${e.claim.findingId}; evidence: ${e.claim.evidenceRefs.join(", ") || "none"}`,
    );
  }
  for (const e of verified) {
    out.push(
      `- verified ${e.claimId} by ${e.verifier.role}${e.verifier.agentId ? `/${e.verifier.agentId}` : ""}${e.rationale ? `: ${truncate(e.rationale, 200)}` : ""}`,
    );
  }
  for (const e of refuted) {
    out.push(
      `- refuted ${e.claimId} by ${e.verifier.role}${e.verifier.agentId ? `/${e.verifier.agentId}` : ""}: ${truncate(e.rationale, 200)}`,
    );
  }
  for (const e of evidence) {
    out.push(
      `- evidence ${e.evidence.id} [${e.evidence.kind}] ${truncate(e.evidence.ref, 140)}: ${truncate(e.evidence.excerpt, 200)} (by ${e.role}${e.agentId ? `/${e.agentId}` : ""}${e.subtaskId ? ` on ${e.subtaskId}` : ""})`,
    );
  }
  return out;
}

function renderSandbox(events: TraceEvent[]): string[] {
  const out = ["## Sandbox and remediation", ""];
  const started = events.filter((e) => e.kind === "sandbox.started");
  const steps = events.filter((e) => e.kind === "sandbox.step");
  const finished = events.filter((e) => e.kind === "sandbox.finished");
  const proposed = events.filter((e) => e.kind === "remediation.proposed");
  if (started.length === 0 && proposed.length === 0) {
    out.push("No sandbox or remediation events.");
    return out;
  }
  for (const e of started) {
    out.push(
      `- sandbox started for ${e.dependency} ${e.from} -> ${e.to} (finding ${e.findingId}, isolation: ${e.isolation})`,
    );
  }
  for (const e of steps) {
    out.push(
      `- sandbox ${e.phase}/${e.step} (finding ${e.findingId}): ${e.result.status}${e.result.exitCode !== null && e.result.exitCode !== undefined ? ` exit ${e.result.exitCode}` : ""} in ${fmtMs(e.result.durationMs)}`,
    );
  }
  for (const e of finished) {
    out.push(
      `- sandbox finished (finding ${e.findingId}): ${e.validation.verdict} via ${e.validation.isolation}${e.validation.note ? ` - ${truncate(e.validation.note, 200)}` : ""}`,
    );
  }
  for (const e of proposed) {
    out.push(
      `- remediation proposed for ${e.dependency} ${e.from} -> ${e.to ?? "n/a"} as ${e.action} (finding ${e.findingId}): ${truncate(e.summary, 250)}`,
    );
  }
  return out;
}

function renderApprovals(events: TraceEvent[]): string[] {
  const out = ["## Approvals - human gates on irreversible actions", ""];
  const requested = events.filter((e) => e.kind === "approval.requested");
  if (requested.length === 0) {
    out.push("No approvals requested.");
    return out;
  }
  const granted = new Map(
    events.filter((e) => e.kind === "approval.granted").map((e) => [e.approvalId, e]),
  );
  const denied = new Map(
    events.filter((e) => e.kind === "approval.denied").map((e) => [e.approvalId, e]),
  );
  for (const e of requested) {
    const g = granted.get(e.approvalId);
    const d = denied.get(e.approvalId);
    const outcome = g
      ? `granted${g.decidedBy ? ` by ${g.decidedBy}` : ""}`
      : d
        ? `denied${d.decidedBy ? ` by ${d.decidedBy}` : ""}${d.reason ? `: ${d.reason}` : ""}`
        : "pending";
    out.push(`- ${e.approvalId}: ${e.tool} - ${outcome}`);
    out.push(`  - payload: ${fmtJson(e.payload, 220)}`);
  }
  return out;
}

function renderBudget(events: TraceEvent[]): string[] {
  const out = ["## Budget - measured spend"];
  const checks = events.filter((e) => e.kind === "budget.checked");
  if (checks.length === 0) {
    out.push("", "No budget checks.");
    return out;
  }
  const last = checks[checks.length - 1]!;
  out.push(
    "",
    `- Steps: ${last.steps.used}/${last.steps.max}`,
    `- Spend: $${last.usd.used.toFixed(4)}/$${last.usd.max}`,
    `- Wall-clock: ${last.ms.used}ms/${last.ms.max}ms`,
    `- Status: ${last.exceeded ? `exceeded ${last.exceeded}` : "within budget"}`,
  );
  return out;
}

function renderOutcome(
  events: TraceEvent[],
  finished: Extract<TraceEvent, { kind: "run.finished" }> | undefined,
): string[] {
  const out = ["## Outcome - final report"];
  const written = events.filter((e) => e.kind === "blackboard.written");
  if (finished) {
    out.push(
      "",
      `- Status: ${finished.status}${finished.summary ? ` - ${truncate(finished.summary, 300)}` : ""}`,
    );
    if (finished.reportKey) out.push(`- Report key: ${finished.reportKey}`);
  } else {
    out.push("", "No `run.finished` event: the run did not terminate cleanly.");
  }
  if (written.length === 0) {
    out.push("- No blackboard writes.");
    return out;
  }
  out.push("", "Blackboard writes:", "");
  for (const e of written) {
    out.push(
      `- ${e.key} [${e.entry.status}] by ${e.entry.writtenBy.role}/${e.entry.writtenBy.agentId}${e.entry.writtenBy.subtaskId ? ` on ${e.entry.writtenBy.subtaskId}` : ""}: ${fmtJson(e.entry.value, 300)}`,
    );
    for (const ev of e.entry.evidence) {
      out.push(
        `  - evidence via ${ev.source}${ev.toolCallId ? ` (${ev.toolCallId})` : ""}: ${truncate(ev.claim ?? ev.quote ?? "", 180)}`,
      );
    }
  }
  return out;
}
