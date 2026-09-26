import React from "react";
import type { SlotRole } from "@punch/shared";
import type { BoardRunState, SlotLaneState } from "@/lib/trace/types";
import { formatAgentDisplayName, formatAgentFull } from "./formatters";

interface SlotsTileProps {
  run: BoardRunState;
  slots: Record<SlotRole, SlotLaneState>;
  planSubtasksCount: number;
}

export default function SlotsTile({ run, slots, planSubtasksCount }: SlotsTileProps) {
  const orchestratorAgentId = run.orchestratorAgentId || "opus-5-5";
  const isRunActive = run.status === "running";
  const isRunCompleted = run.status === "completed";

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

      {/* Planner Card */}
      {(() => {
        const slot = slots.planner;
        const isDone = planSubtasksCount > 0 || slot.state === "completed";
        const isRunning = slot.state === "running" && planSubtasksCount === 0;
        return (
          <div className={`bz-agent ${isDone ? "done" : isRunning ? "running" : ""}`}>
            <span className="role">Planner</span>
            <span className={`bz-chip ${isDone ? "done" : isRunning ? "run" : "ghost"}`}>
              {isDone ? "done" : isRunning ? "running" : "waiting"}
            </span>
            <span className="who">{formatAgentFull(slot.agentId || "opus-5-5")}</span>
            <span className="meta">
              {isDone
                ? `${planSubtasksCount || 7} subtasks · 1 turn · $0.11`
                : isRunning
                  ? "decomposing DAG"
                  : "waiting"}
            </span>
            {slot.standby && slot.standby.length > 0 && !isDone && (
              <span className="standby">
                standby:{" "}
                {slot.standby
                  .map((s) => `${formatAgentDisplayName(s.agentId)} (${s.probability.toFixed(2)})`)
                  .join(" · ")}
              </span>
            )}
          </div>
        );
      })()}

      {/* Researcher Card */}
      {(() => {
        const slot = slots.researcher;
        const isReplacing = slot.state === "replacing";
        const isRunning = slot.state === "running";
        const isDone = slot.state === "completed" && isRunCompleted;
        const isFailed = slot.state === "failed";

        const hasReplaced = slot.replaced && slot.replaced.length > 0;

        return (
          <React.Fragment>
            <div
              className={`bz-agent ${
                isRunning ? "running" : isDone ? "done" : isFailed ? "failed" : isReplacing ? "warn" : ""
              }`}
            >
              <span className="role">Researcher</span>
              <span
                className={`bz-chip ${
                  isRunning ? "run" : isDone ? "done" : isFailed ? "fail" : isReplacing ? "warn" : "ghost"
                }`}
              >
                {isReplacing ? "takeover" : isRunning ? "running" : isDone ? "done" : isFailed ? "failed" : "waiting"}
              </span>
              <span className="who">{formatAgentFull(slot.agentId || "gemini-flash")}</span>
              <span className="meta">
                {hasReplaced
                  ? "s3 · resumed with 5 cached results · heartbeat 0.4s"
                  : isRunning
                    ? `${slot.currentSubtaskId || "s1"} · ${slot.turns || 1} turns · $${(slot.costUsd || 0.05).toFixed(2)}`
                    : isDone
                      ? "s1-s4 done · 8 turns · $0.32"
                      : "ready"}
              </span>
              {slot.standby && slot.standby.length > 0 && (
                <span className="standby">
                  standby:{" "}
                  {slot.standby
                    .map((s) => `${formatAgentDisplayName(s.agentId)} (${s.probability.toFixed(2)})`)
                    .join(" · ")}
                </span>
              )}
            </div>

            {/* Replaced Researcher Stack */}
            {slot.replaced.map((rep, idx) => (
              <div
                key={`replaced-${rep.agentId}-${idx}`}
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
      })()}

      {/* Executor Card */}
      {(() => {
        const slot = slots.executor;
        const isRunning = slot.state === "running";
        const isDone = isRunCompleted || slot.state === "completed";
        return (
          <div className={`bz-agent ${isDone ? "done" : isRunning ? "running" : ""}`}>
            <span className="role">Executor</span>
            <span className={`bz-chip ${isDone ? "done" : isRunning ? "run" : "ghost"}`}>
              {isDone ? "done" : isRunning ? "running" : "waiting"}
            </span>
            <span className="who">{formatAgentFull(slot.agentId || "opus-5-5")}</span>
            <span className="meta">
              {isDone
                ? "draft report & issue filed · 2 turns · $0.21"
                : isRunning
                  ? "drafting remediation report"
                  : "waits on s4"}
            </span>
            {slot.standby && slot.standby.length > 0 && !isDone && (
              <span className="standby">
                standby:{" "}
                {slot.standby
                  .map((s) => `${formatAgentDisplayName(s.agentId)} (${s.probability.toFixed(2)})`)
                  .join(" · ")}
              </span>
            )}
          </div>
        );
      })()}

      {/* Critic Card */}
      {(() => {
        const slot = slots.critic;
        const isRunning = slot.state === "running";
        const isDone = isRunCompleted || slot.state === "completed";
        return (
          <div className={`bz-agent ${isDone ? "done" : isRunning ? "running" : ""}`}>
            <span className="role">Critic</span>
            <span className={`bz-chip ${isDone ? "done" : isRunning ? "run" : "ghost"}`}>
              {isDone ? "done" : isRunning ? "running" : "waiting"}
            </span>
            <span className="who">{formatAgentFull(slot.agentId || "grok")}</span>
            <span className="meta">
              {isDone
                ? "evidence checked · verdict accepted"
                : isRunning
                  ? "verifying claims against citations"
                  : "distinct from executor"}
            </span>
            {slot.standby && slot.standby.length > 0 && !isDone && (
              <span className="standby">
                standby:{" "}
                {slot.standby
                  .map((s) => `${formatAgentDisplayName(s.agentId)} (${s.probability.toFixed(2)})`)
                  .join(" · ")}
              </span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
