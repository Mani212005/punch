import React from "react";
import type { BoardRunState, SlotLaneState } from "@/lib/trace/types";
import { formatAgentDisplayName, formatAgentFull } from "./formatters";

interface SlotsTileProps {
  run: BoardRunState;
  slots: Record<string, SlotLaneState>;
  planSubtasksCount: number;
}

const PREFERRED_ROLE_ORDER = ["planner", "researcher", "executor", "critic"];

function formatRoleTitle(role: string): string {
  return role
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function costText(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function turnsAndCost(slot: SlotLaneState): string {
  const parts: string[] = [];
  if (slot.turns > 0) parts.push(plural(slot.turns, "turn"));
  if (slot.costUsd > 0) parts.push(costText(slot.costUsd));
  return parts.join(" · ");
}

export default function SlotsTile({ run, slots, planSubtasksCount }: SlotsTileProps) {
  const orchestratorAgentId = run.orchestratorAgentId;
  const isRunActive = run.status === "running";
  const isRunCompleted = run.status === "completed";

  // Collect all roles: preferred standard roles first, then any extra roles in slots
  const roleKeys: string[] = [];
  PREFERRED_ROLE_ORDER.forEach((role) => {
    if (slots[role]) {
      roleKeys.push(role);
    }
  });
  Object.keys(slots).forEach((role) => {
    if (!roleKeys.includes(role)) {
      roleKeys.push(role);
    }
  });

  return (
    <div className="bz-tile c3 r2" style={{ gap: "8px" }}>
      <div className="bz-label">slots</div>

      {/* Orchestrator Card (only when the trace names an orchestrator agent) */}
      {orchestratorAgentId && (
        <div className={`bz-agent ${isRunCompleted ? "done" : isRunActive ? "running" : ""}`}>
          <span className="role">Orchestrator</span>
          <span className={`bz-chip ${isRunCompleted ? "done" : isRunActive ? "run" : "ghost"}`}>
            {isRunCompleted ? "done" : isRunActive ? "running" : "waiting"}
          </span>
          <span className="who">{formatAgentFull(orchestratorAgentId)}</span>
          <span className="meta">
            {isRunCompleted ? "run complete" : isRunActive ? "narrating" : "ready"}
          </span>
        </div>
      )}

      {/* Dynamic Role Cards */}
      {roleKeys.map((roleKey) => {
        const slot = slots[roleKey];
        if (!slot) return null;

        const roleTitle = formatRoleTitle(roleKey);
        const isReplacing = slot.state === "replacing";
        const isRunning = slot.state === "running";
        const isDone =
          slot.state === "completed" ||
          (roleKey === "planner" && planSubtasksCount > 0) ||
          isRunCompleted;
        const isFailed = slot.state === "failed";
        const hasReplaced = slot.replaced && slot.replaced.length > 0;

        // Descriptive meta text, built only from slot state - no fabricated numbers.
        const subtask = slot.currentSubtaskId;
        const tc = turnsAndCost(slot);
        const withSub = (base: string) => (subtask ? `${subtask} · ${base}` : base);
        let metaText = "ready";
        if (roleKey === "planner") {
          metaText = isDone
            ? [`${planSubtasksCount} subtasks`, tc].filter(Boolean).join(" · ")
            : isRunning
              ? "decomposing DAG"
              : "waiting";
        } else if (roleKey === "researcher") {
          metaText = hasReplaced
            ? withSub(["resumed", tc].filter(Boolean).join(" · "))
            : isRunning || isDone
              ? withSub(tc || (isDone ? "done" : "started"))
              : "ready";
        } else if (roleKey === "executor") {
          metaText =
            isRunning || isDone
              ? withSub([isDone ? "done" : "working", tc].filter(Boolean).join(" · "))
              : "waiting";
        } else if (roleKey === "critic") {
          metaText = isDone ? "review complete" : isRunning ? "reviewing" : "waiting";
        } else {
          metaText = isRunning
            ? withSub(tc || "started")
            : isDone
              ? "completed"
              : isFailed
                ? "failed"
                : "waiting";
        }

        const agentClass = isRunning
          ? "running"
          : isDone
            ? "done"
            : isFailed
              ? "failed"
              : isReplacing
                ? "warn"
                : "";

        const chipClass = isRunning
          ? "run"
          : isDone
            ? "done"
            : isFailed
              ? "fail"
              : isReplacing
                ? "warn"
                : "ghost";

        const chipText = isReplacing
          ? "takeover"
          : isRunning
            ? "running"
            : isDone
              ? "done"
              : isFailed
                ? "failed"
                : "waiting";

        return (
          <React.Fragment key={roleKey}>
            <div className={`bz-agent ${agentClass}`}>
              <span className="role">{roleTitle}</span>
              <span className={`bz-chip ${chipClass}`}>{chipText}</span>
              <span className="who">{formatAgentFull(slot.agentId || "unassigned")}</span>
              <span className="meta">{metaText}</span>
              {slot.standby && slot.standby.length > 0 && !isDone && (
                <span className="standby">
                  standby:{" "}
                  {slot.standby
                    .map(
                      (s) => `${formatAgentDisplayName(s.agentId)} (${s.probability.toFixed(2)})`,
                    )
                    .join(" · ")}
                </span>
              )}
            </div>

            {/* Replaced Agent Stack */}
            {slot.replaced &&
              slot.replaced.map((rep, idx) => (
                <div
                  key={`replaced-${roleKey}-${rep.agentId}-${idx}`}
                  className="bz-agent replaced"
                  style={{ marginLeft: "12px" }}
                >
                  <span className="role">
                    <span className="bz-glyph replaced" style={{ marginRight: "4px" }} />
                    replaced: {formatAgentDisplayName(rep.agentId)}
                  </span>
                  <span className="bz-chip fail">{rep.reason.kind || "failed"}</span>
                  <span className="who">
                    {rep.reason.detail || rep.reason.kind} · {plural(rep.turns, "turn")} ·{" "}
                    {costText(rep.costUsd)}
                  </span>
                  <span className="meta">
                    {rep.subtaskId ? `${rep.subtaskId} handed over` : "subtask handed over"}
                  </span>
                </div>
              ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}
