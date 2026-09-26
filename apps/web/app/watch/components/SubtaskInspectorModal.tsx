import React from "react";
import type { BlackboardEntry, Subtask } from "@punch/shared";
import type { LogEntry } from "@/lib/trace/types";
import { formatAgentDisplayName } from "./formatters";

interface SubtaskInspectorModalProps {
  subtask: Subtask | null;
  blackboard: Record<string, BlackboardEntry>;
  logs: LogEntry[];
  onClose: () => void;
}

export default function SubtaskInspectorModal({
  subtask,
  blackboard,
  logs,
  onClose,
}: SubtaskInspectorModalProps) {
  if (!subtask) return null;

  const outputKey = subtask.output?.key;
  const outputEntry = outputKey ? blackboard[outputKey] : undefined;

  const subtaskLogs = logs.filter((l) => l.subtaskId === subtask.id);

  const statusClass =
    subtask.status === "completed"
      ? "done"
      : subtask.status === "running"
        ? "run"
        : subtask.status === "failed" || subtask.status === "degraded"
          ? "fail"
          : "ghost";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(18, 18, 18, 0.65)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={onClose}
    >
      <div
        className="bz-tile"
        style={{
          width: "100%",
          maxWidth: "840px",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--bz-paper)",
          border: "2px solid var(--bz-ink)",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subtask-modal-title"
      >
        {/* Modal Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "2px solid var(--bz-ink)",
            paddingBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className={`bz-glyph lg ${statusClass}`} />
            <h2
              id="subtask-modal-title"
              className="bz-h3"
              style={{ margin: 0, fontSize: "18px" }}
            >
              {subtask.id} · {subtask.title}
            </h2>
            <span className={`bz-chip ${statusClass}`}>{subtask.status}</span>
          </div>
          <button
            type="button"
            className="bz-btn sm"
            onClick={onClose}
            aria-label="Close inspector"
          >
            ✕ Close
          </button>
        </div>

        {/* Subtask Description */}
        {subtask.description && (
          <p className="bz-lead bz-muted" style={{ margin: 0, fontSize: "14px" }}>
            {subtask.description}
          </p>
        )}

        {/* Metadata Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "10px",
            fontSize: "12px",
          }}
        >
          <div className="bz-field">
            <span className="bz-label">role hint / assignee</span>
            <span className="bz-mono">
              {subtask.roleHint || "unassigned"} (assignee: {subtask.assignee})
            </span>
          </div>

          <div className="bz-field">
            <span className="bz-label">dependencies</span>
            <span className="bz-mono">
              {subtask.dependsOn.length > 0 ? subtask.dependsOn.join(", ") : "none (root)"}
            </span>
          </div>

          <div className="bz-field">
            <span className="bz-label">output key</span>
            <span className="bz-mono">{outputKey || "none"}</span>
          </div>
        </div>

        {/* Inputs and Output Blackboard Values */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {/* Inputs Section */}
          <div className="bz-tile alt" style={{ padding: "10px", gap: "6px" }}>
            <div className="bz-label">inputs ({subtask.inputKeys.length})</div>
            {subtask.inputKeys.length === 0 ? (
              <span className="bz-mono bz-muted" style={{ fontSize: "11px" }}>
                No blackboard dependencies
              </span>
            ) : (
              subtask.inputKeys.map((key) => {
                const entry = blackboard[key];
                return (
                  <div
                    key={key}
                    style={{
                      borderBottom: "1px solid var(--bz-ink-3)",
                      paddingBottom: "4px",
                      marginBottom: "4px",
                    }}
                  >
                    <div className="bz-mono" style={{ fontWeight: 600, fontSize: "11px" }}>
                      {key}
                    </div>
                    {entry ? (
                      <pre
                        className="bz-mono"
                        style={{
                          margin: 0,
                          fontSize: "10px",
                          maxHeight: "100px",
                          overflow: "auto",
                        }}
                      >
                        {JSON.stringify(entry.value, null, 2)}
                      </pre>
                    ) : (
                      <span className="bz-mono bz-muted" style={{ fontSize: "10px" }}>
                        (not yet written)
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Output Section */}
          <div className="bz-tile alt" style={{ padding: "10px", gap: "6px" }}>
            <div className="bz-label">output value</div>
            {outputEntry ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <div className="bz-mono" style={{ fontSize: "11px", fontWeight: 600 }}>
                  written by {formatAgentDisplayName(outputEntry.writtenBy.agentId)} (
                  {outputEntry.writtenBy.role})
                </div>
                <pre
                  className="bz-mono"
                  style={{
                    margin: 0,
                    fontSize: "10px",
                    maxHeight: "140px",
                    overflow: "auto",
                    background: "var(--bz-paper)",
                    padding: "6px",
                    border: "1px solid var(--bz-ink-3)",
                  }}
                >
                  {JSON.stringify(outputEntry.value, null, 2)}
                </pre>
                {outputEntry.evidence && outputEntry.evidence.length > 0 && (
                  <div style={{ marginTop: "4px" }}>
                    <div className="bz-label" style={{ fontSize: "9px" }}>
                      evidence & citations ({outputEntry.evidence.length})
                    </div>
                    <ul style={{ margin: "2px 0 0 16px", padding: 0, fontSize: "10px" }}>
                      {outputEntry.evidence.map((ev, i) => (
                        <li key={i} className="bz-mono">
                          source: {ev.source}{" "}
                          {ev.toolCallId ? `(tool: ${ev.toolCallId})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <span className="bz-mono bz-muted" style={{ fontSize: "11px" }}>
                Output not yet produced
              </span>
            )}
          </div>
        </div>

        {/* Subtask Logs */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="bz-label">subtask logs ({subtaskLogs.length})</div>
          <div
            className="bz-log"
            style={{ maxHeight: "180px", overflowY: "auto", fontSize: "11px" }}
          >
            {subtaskLogs.length === 0 ? (
              <div className="dim">No log entries specific to {subtask.id}</div>
            ) : (
              subtaskLogs.map((l, i) => (
                <div key={i}>
                  {l.type === "tool_call" && l.toolCall && (
                    <div>
                      <span className="info">&gt; call</span> {l.toolCall.tool}{" "}
                      <span className="dim">{JSON.stringify(l.toolCall.input)}</span>
                    </div>
                  )}
                  {l.type === "tool_result" && l.toolResult && (
                    <div>
                      <span className={l.toolResult.ok ? "ok" : "err"}>
                        {l.toolResult.ok ? "200" : "ERR"}
                      </span>{" "}
                      {l.toolResult.tool}{" "}
                      {l.toolResult.cached && <span className="dim">cached</span>}{" "}
                      <span className="dim">{l.toolResult.latencyMs}ms</span>
                    </div>
                  )}
                  {l.type === "blackboard" && l.blackboard && (
                    <div>
                      <span className="info">write</span> {l.blackboard.key}
                    </div>
                  )}
                  {l.type === "text" && l.text && <div>&ldquo;{l.text}&rdquo;</div>}
                  {l.type === "slot" && (
                    <div className={l.slotInfo?.state === "failed" ? "err" : "warn"}>
                      {l.text}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
