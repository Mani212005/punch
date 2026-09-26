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

export default function SlotsTile({ run, slots, planSubtasksCount }: SlotsTileProps) {
  const orchestratorAgentId = run.orchestratorAgentId || "opus-5-5";
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

      {/* Orchestrator Card */}
      <div className={`bz-agent ${isRunCompleted ? "done" : isRunActive ? "running" : ""}`}>
        <span className="role">Orchestrator</span>
        <span className={`bz-chip ${isRunCompleted ? "done" : isRunActive ? "run" : "ghost"}`}>
          {isRunCompleted ? "done" : isRunActive ? "running" : "waiting"}
        </span>
        <span className="who">{formatAgentFull(orchestratorAgentId)}</span>
        <span className="meta">
          {isRunCompleted
            ? "run complete · 3 turns · $0.09"
            : isRunActive
              ? "narrating · 3 turns · $0.09"
              : "ready"}
        </span>
      </div>

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

        // Determine descriptive meta text
        let metaText = "ready";
        if (roleKey === "planner") {
          metaText = isDone
            ? `${planSubtasksCount || 7} subtasks · 1 turn · $0.11`
            : isRunning
              ? "decomposing DAG"
              : "waiting";
        } else if (roleKey === "researcher") {
          metaText = hasReplaced
            ? "s3 · resumed with 5 cached results · heartbeat 0.4s"
            : isRunning
              ? `${slot.currentSubtaskId || "s1"} · ${slot.turns || 1} turns · $${(slot.costUsd || 0.05).toFixed(2)}`
              : isDone
                ? "s1-s4 done · 8 turns · $0.32"
                : "ready";
        } else if (roleKey === "executor") {
          metaText = isDone
            ? "draft report & issue filed · 2 turns · $0.21"
            : isRunning
              ? "drafting remediation report"
              : "waits on s4";
        } else if (roleKey === "critic") {
          metaText = isDone
            ? "evidence checked · verdict accepted"
            : isRunning
              ? "verifying claims against citations"
              : "distinct from executor";
        } else {
          metaText = isRunning
            ? `${slot.currentSubtaskId ? `${slot.currentSubtaskId} · ` : ""}${slot.turns || 0} turns`
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
                    {rep.reason.detail || rep.reason.kind} · {rep.turns || 6} turns · $
                    {(rep.costUsd || 0.27).toFixed(2)}
                  </span>
                  <span className="meta">
                    {rep.subtaskId
                      ? `s1, s2 done · ${rep.subtaskId} handed over`
                      : "subtask handed over"}
                  </span>
                </div>
              ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}
