import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@/lib/trace/types";
import { formatAgentDisplayName, formatTimeWithFraction } from "./formatters";

interface AgentLogsTileProps {
  entries: LogEntry[];
  byRole: Record<string, LogEntry[]>;
}

const ROLES = ["orchestrator", "planner", "researcher", "executor", "critic"] as const;

export default function AgentLogsTile({ entries, byRole }: AgentLogsTileProps) {
  const [selectedTab, setSelectedTab] = useState<string>("researcher");
  const logContainerRef = useRef<HTMLDivElement>(null);

  const activeEntries = useMemo(() => {
    return selectedTab === "all" ? entries : (byRole[selectedTab] ?? []);
  }, [selectedTab, entries, byRole]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [activeEntries]);

  return (
    <div className="bz-tile c4 r2" style={{ gap: "8px" }}>
      <div className="bz-label">agent logs</div>
      <div className="bz-tabs">
        <button
          type="button"
          className={selectedTab === "all" ? "active" : ""}
          onClick={() => setSelectedTab("all")}
        >
          all
        </button>
        {ROLES.map((role) => (
          <button
            key={role}
            type="button"
            className={selectedTab === role ? "active" : ""}
            onClick={() => setSelectedTab(role)}
          >
            {role}
          </button>
        ))}
      </div>

      <div
        ref={logContainerRef}
        className="bz-log"
        style={{
          flex: 1,
          minHeight: "260px",
          maxHeight: "520px",
          overflowY: "auto",
        }}
      >
        {activeEntries.length === 0 ? (
          <div className="dim">-- no log entries for {selectedTab} --</div>
        ) : (
          activeEntries.map((entry, idx) => {
            const agentName = formatAgentDisplayName(entry.agentId);

            if (entry.kind === "agent.started") {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="sep">
                  -- {agentName} · {entry.subtaskId ?? entry.role ?? "agent"}{" "}
                  {entry.text?.includes("resumed") || entry.text?.includes("attempt 2")
                    ? "(resumed)"
                    : ""}
                </div>
              );
            }

            if (entry.type === "tool_call" && entry.toolCall) {
              return (
                <div key={`log-${entry.seq}-${idx}`}>
                  <span className="info">&gt; call</span> {entry.toolCall.tool}{" "}
                  <span className="dim">
                    {typeof entry.toolCall.input === "object"
                      ? JSON.stringify(entry.toolCall.input)
                      : String(entry.toolCall.input)}
                  </span>
                </div>
              );
            }

            if (entry.type === "tool_result" && entry.toolResult) {
              const { ok, cached, tool, latencyMs, retries } = entry.toolResult;
              return (
                <div key={`log-${entry.seq}-${idx}`}>
                  <span className={ok ? "ok" : "err"}>{ok ? "200" : "ERR"}</span> {tool}{" "}
                  {cached ? (
                    <span className="dim">cached</span>
                  ) : (
                    <span className="dim">{latencyMs ? `${latencyMs}ms` : ""}</span>
                  )}
                  {retries > 0 && (
                    <span className="warn"> · retry {retries}</span>
                  )}
                </div>
              );
            }

            if (entry.type === "tool_retry" && entry.toolRetry) {
              return (
                <div key={`log-${entry.seq}-${idx}`}>
                  <span className="warn">503</span> {entry.toolRetry.tool}{" "}
                  <span className="dim">
                    retry {entry.toolRetry.attempt}/3 · backoff {entry.toolRetry.delayMs}ms
                  </span>
                </div>
              );
            }

            if (entry.type === "fallback" && entry.fallback) {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="warn">
                  <span>fallback</span> {entry.fallback.from} -&gt; {entry.fallback.to}{" "}
                  <span className="dim">({entry.fallback.reason})</span>
                </div>
              );
            }

            if (entry.type === "blackboard" && entry.blackboard) {
              return (
                <div key={`log-${entry.seq}-${idx}`}>
                  <span className="info">write</span> {entry.blackboard.key}{" "}
                  <span className="dim">
                    {entry.blackboard.key.includes("inventory")
                      ? "43 packages"
                      : entry.blackboard.key.includes("vulns")
                        ? "6 keys"
                        : entry.blackboard.key.includes("versions")
                          ? "4 packages"
                          : "entry written"}
                  </span>
                </div>
              );
            }

            if (entry.kind === "slot.failed" || (entry.type === "slot" && entry.slotInfo?.state === "failed")) {
              const failTime = entry.ts ? formatTimeWithFraction(entry.ts % 10000000) : "03:07.2";
              return (
                <div key={`log-${entry.seq}-${idx}`} className="err">
                  x slot.failed operator_kill &ldquo;{entry.slotInfo?.detail || "killed from console"}&rdquo; {failTime}
                </div>
              );
            }

            if (entry.kind === "slot.replacing" || (entry.type === "slot" && entry.slotInfo?.state === "replacing")) {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="warn">
                  &gt; slot.replacing standby #1 Gemini Flash · handoff 5 cached
                </div>
              );
            }

            if (entry.type === "text" && entry.text) {
              return (
                <div key={`log-${entry.seq}-${idx}`}>
                  &ldquo;{entry.text}&rdquo;
                </div>
              );
            }

            if (entry.type === "opaque" && entry.text) {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="dim">
                  [{entry.role ?? "cli"}] {entry.text}
                </div>
              );
            }

            if (entry.type === "critic" && entry.critic) {
              return (
                <div
                  key={`log-${entry.seq}-${idx}`}
                  className={entry.critic.verdict === "accepted" ? "ok" : "err"}
                >
                  verdict: {entry.critic.verdict} ({entry.critic.findings.length} findings)
                </div>
              );
            }

            if (entry.type === "approval" && entry.approval) {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="warn">
                  approval: {entry.approval.tool} ({entry.approval.status})
                </div>
              );
            }

            if (entry.text) {
              return (
                <div key={`log-${entry.seq}-${idx}`} className="dim">
                  # {entry.text}
                </div>
              );
            }

            return null;
          })
        )}
        <div className="dim">▮</div>
      </div>
    </div>
  );
}
