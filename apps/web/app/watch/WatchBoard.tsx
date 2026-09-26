"use client";

import React, { useMemo, useState } from "react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { createEventSource, useReplayController } from "@/lib/trace";
import type { EventSourceConfig } from "@/lib/trace";
import type { SlotRole } from "@punch/shared";

interface WatchBoardProps {
  initialTraceId?: string;
}

const ROLES: SlotRole[] = ["planner", "researcher", "executor", "critic"];

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function WatchBoard({ initialTraceId = "takeover" }: WatchBoardProps) {
  const [sourceConfig, setSourceConfig] = useState<EventSourceConfig>({
    kind: "static",
    traceId: initialTraceId,
  });
  const [selectedRoleTab, setSelectedRoleTab] = useState<string>("all");
  const [liveEngineUrl, setLiveEngineUrl] = useState<string>("http://localhost:4141");
  const [liveToken, setLiveToken] = useState<string>("");
  const [showLiveModal, setShowLiveModal] = useState<boolean>(false);

  const eventSource = useMemo(() => {
    try {
      return createEventSource(sourceConfig);
    } catch {
      return null;
    }
  }, [sourceConfig]);

  const {
    state,
    currentIndex,
    totalEvents,
    isPlaying,
    speed,
    loading,
    error,
    togglePlay,
    stepForward,
    stepBackward,
    scrubTo,
    setSpeed,
  } = useReplayController(eventSource, { autoPlay: false, defaultSpeed: 1 });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSourceConfig({ kind: "file", file });
    }
  };

  const handleConnectLive = (e: React.FormEvent) => {
    e.preventDefault();
    setSourceConfig({
      kind: "sse",
      engineUrl: liveEngineUrl,
      token: liveToken,
    });
    setShowLiveModal(false);
  };

  const currentRoleLogs = useMemo(() => {
    if (selectedRoleTab === "all") {
      return state.logs.entries;
    }
    return state.logs.byRole[selectedRoleTab] ?? [];
  }, [state.logs, selectedRoleTab]);

  const activeRouting = state.routing["researcher"] ?? Object.values(state.routing)[0];

  return (
    <main>
      <div
        className="bz"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "14px",
          maxWidth: "1280px",
          margin: "0 auto",
        }}
      >
        <Header />

        {/* Top Control and Navigation Bar */}
        <div
          className="bz-nav"
          style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className="bz-label">trace source:</span>
            <div className="bz-seg">
              <button
                className={`bz-btn sm ${sourceConfig.kind === "static" && sourceConfig.traceId === "takeover" ? "primary" : ""}`}
                onClick={() => setSourceConfig({ kind: "static", traceId: "takeover" })}
              >
                Takeover Run
              </button>
              <label
                className={`bz-btn sm ${sourceConfig.kind === "file" ? "primary" : ""}`}
                style={{
                  cursor: "pointer",
                  margin: 0,
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                Load Local File
                <input
                  type="file"
                  accept=".jsonl,.json"
                  onChange={handleFileUpload}
                  style={{ display: "none" }}
                />
              </label>
              <button
                className={`bz-btn sm ${sourceConfig.kind === "sse" ? "primary" : ""}`}
                onClick={() => setShowLiveModal(true)}
              >
                Connect Live SSE
              </button>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {loading && <span className="bz-chip warn">loading trace...</span>}
            {error && <span className="bz-chip fail">error: {error.message}</span>}
            {sourceConfig.kind === "static" && (
              <span className="bz-mono bz-muted">traces/{sourceConfig.traceId}.jsonl</span>
            )}
            {sourceConfig.kind === "file" && (
              <span className="bz-mono bz-muted">file: {sourceConfig.file.name}</span>
            )}
            {sourceConfig.kind === "sse" && (
              <span className="bz-mono bz-muted">paired: {sourceConfig.engineUrl}</span>
            )}
          </div>
        </div>

        {/* Live SSE Modal */}
        {showLiveModal && (
          <div
            className="bz-tile yellow c12"
            style={{ position: "relative", border: "2px solid var(--bz-ink)", padding: "16px" }}
          >
            <div className="bz-label">connect to local engine</div>
            <form
              onSubmit={handleConnectLive}
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                <div>
                  <label className="bz-label">engine url</label>
                  <input
                    className="bz-input"
                    value={liveEngineUrl}
                    onChange={(e) => setLiveEngineUrl(e.target.value)}
                    placeholder="http://localhost:4141"
                  />
                </div>
                <div>
                  <label className="bz-label">pairing / bearer token</label>
                  <input
                    className="bz-input"
                    value={liveToken}
                    onChange={(e) => setLiveToken(e.target.value)}
                    placeholder="bearer token"
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button type="button" className="bz-btn sm" onClick={() => setShowLiveModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="bz-btn primary sm">
                  Connect Stream
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="bz-grid">
          {/* Run Tile */}
          <div
            className="bz-tile c8"
            style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: "10px" }}
          >
            <span
              className={`bz-glyph lg ${
                state.run.status === "running"
                  ? state.run.isTakeoverInProgress
                    ? "warn"
                    : "run"
                  : state.run.status === "completed"
                    ? "done"
                    : state.run.status === "failed"
                      ? "fail"
                      : "wait"
              }`}
            />
            <div>
              <div className="bz-label">run</div>
              <div className="bz-h3 bz-num" style={{ fontSize: "16px" }}>
                {state.run.runId || "waiting for run..."}
              </div>
            </div>
            <span className="bz-chip">{state.run.mode}</span>
            {state.run.repoUrl && <span className="bz-mono">{state.run.repoUrl}</span>}
            {state.run.isTakeoverInProgress && (
              <span className="bz-chip warn" style={{ marginLeft: "auto" }}>
                takeover in progress
              </span>
            )}
            {!state.run.isTakeoverInProgress && state.run.status && (
              <span
                className={`bz-chip ${
                  state.run.status === "completed"
                    ? "done"
                    : state.run.status === "running"
                      ? "run"
                      : state.run.status === "failed"
                        ? "fail"
                        : "ghost"
                }`}
                style={{ marginLeft: "auto" }}
              >
                {state.run.status}
              </span>
            )}
          </div>

          {/* Budget Tile */}
          <div className="bz-tile c4" style={{ gap: "6px" }}>
            <div className="bz-label">budget · measured</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "52px minmax(0,1fr) 70px",
                gap: "8px",
                alignItems: "center",
                fontSize: "11px",
              }}
            >
              <span className="bz-mono">steps</span>
              <div className="bz-bar">
                <i
                  style={{
                    width: `${state.budget.steps.max > 0 ? Math.min(100, (state.budget.steps.used / state.budget.steps.max) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="bz-num" style={{ textAlign: "right" }}>
                {state.budget.steps.used} / {state.budget.steps.max}
              </span>

              <span className="bz-mono">usd</span>
              <div className="bz-bar">
                <i
                  style={{
                    width: `${state.budget.usd.max > 0 ? Math.min(100, (state.budget.usd.used / state.budget.usd.max) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="bz-num" style={{ textAlign: "right" }}>
                {state.budget.usd.used.toFixed(2)} / {state.budget.usd.max.toFixed(2)}
              </span>

              <span className="bz-mono">clock</span>
              <div className="bz-bar">
                <i
                  style={{
                    width: `${state.budget.ms.max > 0 ? Math.min(100, (state.budget.ms.used / state.budget.ms.max) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="bz-num" style={{ textAlign: "right" }}>
                {formatTime(state.budget.ms.used)} / {formatTime(state.budget.ms.max)}
              </span>
            </div>
          </div>

          {/* Takeover Banner */}
          {state.takeover.active && (
            <div className="bz-banner c12">
              <span className="bz-glyph lg warn" style={{ marginTop: "3px" }} />
              <div>
                <div className="bz-h3">
                  {state.takeover.active.role.toUpperCase()} slot:{" "}
                  {state.takeover.active.failedAgentId} failed ({state.takeover.active.reason.kind}
                  ). {state.takeover.active.replacementAgentId}{" "}
                  {state.takeover.active.status === "replacing" ? "is taking over" : "took over"}.
                </div>
                {state.takeover.active.reason.detail && (
                  <div className="bz-muted" style={{ fontSize: "12px", marginTop: "2px" }}>
                    Reason: &ldquo;{state.takeover.active.reason.detail}&rdquo;
                  </div>
                )}
              </div>
              <div className="facts">
                <div>
                  <b>why this replacement</b>
                  {state.takeover.active.selection.provenance === "standby"
                    ? `Standby #${state.takeover.active.selection.rank ?? 1} from Jev's routing${state.takeover.active.selection.probability ? `, p=${state.takeover.active.selection.probability}` : ""}.`
                    : `Selected via ${state.takeover.active.selection.provenance}.`}
                </div>
                <div>
                  <b>handed over</b>
                  Subtask {state.takeover.active.subtaskId ?? "active"},{" "}
                  {state.takeover.active.handoff.cachedResultCount} cached tool results, inputs (
                  {state.takeover.active.handoff.inputKeys.join(", ") || "initial"}).
                </div>
                <div>
                  <b>detection to takeover</b>
                  {state.takeover.active.takeoverMs
                    ? `${state.takeover.active.takeoverMs}ms`
                    : state.takeover.active.detectionMs
                      ? `${state.takeover.active.detectionMs}ms`
                      : "< 2s"}
                  . Replacements used {state.takeover.active.replacementsUsed} of{" "}
                  {state.takeover.active.maxReplacements}.
                </div>
              </div>
            </div>
          )}

          {/* Slots Tile */}
          <div className="bz-tile c4 r2" style={{ gap: "8px" }}>
            <div className="bz-label">slots</div>
            {ROLES.map((role) => {
              const slot = state.slots[role];
              const isCurrentRunning = slot.state === "running";
              const isDone = slot.state === "completed";
              const isFailed = slot.state === "failed";
              const isStalled = slot.state === "stalled";
              const isReplacing = slot.state === "replacing";

              return (
                <React.Fragment key={role}>
                  <div
                    className={`bz-agent ${
                      isCurrentRunning
                        ? "running"
                        : isDone
                          ? "done"
                          : isFailed
                            ? "failed"
                            : isStalled || isReplacing
                              ? "warn"
                              : ""
                    }`}
                  >
                    <span className="role" style={{ textTransform: "capitalize" }}>
                      {role}
                    </span>
                    <span
                      className={`bz-chip ${
                        isCurrentRunning
                          ? "run"
                          : isDone
                            ? "done"
                            : isFailed
                              ? "fail"
                              : isStalled || isReplacing
                                ? "warn"
                                : "ghost"
                      }`}
                    >
                      {slot.state}
                    </span>
                    <span className="who">
                      {slot.agentId || "unassigned"} {slot.provenance ? `· ${slot.provenance}` : ""}
                    </span>
                    <span className="meta">
                      {slot.currentSubtaskId ? `subtask ${slot.currentSubtaskId} · ` : ""}
                      {slot.turns} turns
                      {slot.costUsd > 0 ? ` · $${slot.costUsd.toFixed(2)}` : ""}
                    </span>
                    {slot.standby && slot.standby.length > 0 && (
                      <span className="standby">
                        standby:{" "}
                        {slot.standby
                          .map((s) => `${s.agentId} (${s.probability.toFixed(2)})`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>

                  {/* Replaced agent stack */}
                  {slot.replaced.map((rep, idx) => (
                    <div
                      key={`rep-${role}-${idx}`}
                      className="bz-agent replaced"
                      style={{ marginLeft: "12px" }}
                    >
                      <span className="role">
                        <span className="bz-glyph replaced" style={{ marginRight: "4px" }} />
                        replaced: {rep.agentId}
                      </span>
                      <span className="bz-chip fail">{rep.reason.kind}</span>
                      <span className="who">
                        {rep.reason.detail} · {rep.turns} turns
                      </span>
                      {rep.subtaskId && (
                        <span className="meta">subtask {rep.subtaskId} handed over</span>
                      )}
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </div>

          {/* Plan Graph Tile */}
          <div className="bz-tile c4" style={{ gap: "8px" }}>
            <div className="bz-label">plan graph · {state.plan.subtasks.length} subtasks</div>
            {state.plan.subtasks.length === 0 ? (
              <div className="bz-muted" style={{ fontSize: "12px", padding: "12px" }}>
                Waiting for planner to generate DAG...
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {state.plan.subtasks.map((st) => (
                  <div
                    key={st.id}
                    style={{
                      border: "2px solid var(--bz-ink)",
                      borderRadius: "6px",
                      padding: "6px 8px",
                      background:
                        st.status === "completed"
                          ? "var(--bz-paper-2)"
                          : st.status === "running"
                            ? "color-mix(in srgb, var(--bz-blue) 12%, var(--bz-paper))"
                            : st.status === "degraded" || st.status === "failed"
                              ? "color-mix(in srgb, var(--bz-red) 12%, var(--bz-paper))"
                              : "var(--bz-paper)",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <span
                      className={`bz-glyph ${
                        st.status === "completed"
                          ? "done"
                          : st.status === "running"
                            ? "run"
                            : st.status === "failed" || st.status === "degraded"
                              ? "fail"
                              : "wait"
                      }`}
                    />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "12px" }}>
                        {st.id} · {st.title}
                      </div>
                      <div className="bz-muted" style={{ fontSize: "10px" }}>
                        {st.roleHint}{" "}
                        {st.dependsOn.length > 0 ? `· depends: ${st.dependsOn.join(",")}` : ""}
                      </div>
                    </div>
                    <span
                      className={`bz-chip ${
                        st.status === "completed"
                          ? "done"
                          : st.status === "running"
                            ? "run"
                            : st.status === "failed" || st.status === "degraded"
                              ? "fail"
                              : "ghost"
                      }`}
                    >
                      {st.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Routing Card Tile */}
          <div className="bz-tile c4" style={{ gap: "6px" }}>
            <div className="bz-label">
              routing · {activeRouting ? activeRouting.role : "initial"} · auto
            </div>
            {activeRouting ? (
              <>
                <div
                  style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "11px" }}
                  className="bz-mono bz-muted"
                >
                  {activeRouting.difficulty && <span>difficulty {activeRouting.difficulty}</span>}
                  <span>confidence {activeRouting.confidence.toFixed(2)}</span>
                  <span>provenance {activeRouting.provenance ?? "jev"}</span>
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}
                >
                  {activeRouting.probabilities.map((prob) => {
                    const isChosen = prob.agentId === activeRouting.agentId;
                    return (
                      <div key={prob.agentId} className="bz-prob">
                        <span style={{ fontWeight: isChosen ? 700 : 400 }}>{prob.agentId}</span>
                        <div className={`bz-bar ${isChosen ? "" : "ghost"}`}>
                          <i style={{ width: `${Math.round(prob.probability * 100)}%` }} />
                        </div>
                        <span className="bz-num">{prob.probability.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="bz-muted" style={{ fontSize: "12px" }}>
                No routing decisions recorded yet.
              </div>
            )}
          </div>

          {/* Agent Logs Tile */}
          <div className="bz-tile c8 r2" style={{ gap: "8px" }}>
            <div className="bz-label">agent logs</div>
            <div className="bz-tabs">
              <button
                className={selectedRoleTab === "all" ? "active" : ""}
                onClick={() => setSelectedRoleTab("all")}
              >
                All
              </button>
              {ROLES.map((r) => (
                <button
                  key={r}
                  className={selectedRoleTab === r ? "active" : ""}
                  onClick={() => setSelectedRoleTab(r)}
                >
                  {r}
                </button>
              ))}
            </div>

            <div className="bz-log" style={{ flex: 1, minHeight: "220px", maxHeight: "360px" }}>
              {currentRoleLogs.length === 0 ? (
                <div className="dim">No log events for selected filter.</div>
              ) : (
                currentRoleLogs.map((entry, idx) => (
                  <div key={`log-${entry.seq}-${idx}`} style={{ marginBottom: "3px" }}>
                    {entry.type === "tool_call" && entry.toolCall && (
                      <div>
                        <span className="info">&gt; call</span> {entry.toolCall.tool}{" "}
                        <span className="dim">{JSON.stringify(entry.toolCall.input)}</span>
                      </div>
                    )}
                    {entry.type === "tool_result" && entry.toolResult && (
                      <div>
                        <span className={entry.toolResult.ok ? "ok" : "err"}>
                          {entry.toolResult.ok ? "200" : "ERR"}
                        </span>{" "}
                        {entry.toolResult.tool}{" "}
                        {entry.toolResult.cached && <span className="warn">[cached]</span>}{" "}
                        <span className="dim">{entry.toolResult.latencyMs}ms</span>
                        {entry.toolResult.retries > 0 && (
                          <span className="warn"> · retry {entry.toolResult.retries}</span>
                        )}
                      </div>
                    )}
                    {entry.type === "tool_retry" && entry.toolRetry && (
                      <div className="warn">
                        <span>503 retry {entry.toolRetry.attempt}</span> {entry.toolRetry.tool}{" "}
                        <span className="dim">
                          backoff {entry.toolRetry.delayMs}ms ({entry.toolRetry.error})
                        </span>
                      </div>
                    )}
                    {entry.type === "fallback" && entry.fallback && (
                      <div className="warn">
                        <span>fallback</span> {entry.fallback.from} -&gt; {entry.fallback.to}{" "}
                        <span className="dim">({entry.fallback.reason})</span>
                      </div>
                    )}
                    {entry.type === "blackboard" && entry.blackboard && (
                      <div>
                        <span className="info">write</span> {entry.blackboard.key}
                      </div>
                    )}
                    {entry.type === "slot" && (
                      <div className={entry.slotInfo?.state === "failed" ? "err" : "warn"}>
                        {entry.text}
                      </div>
                    )}
                    {entry.type === "text" && (
                      <div>
                        <span className="dim">[{entry.role ?? "agent"}]</span> &ldquo;{entry.text}
                        &rdquo;
                      </div>
                    )}
                    {entry.type === "opaque" && (
                      <div className="dim">
                        [{entry.role ?? "cli"}] {entry.text}
                      </div>
                    )}
                    {entry.type === "critic" && (
                      <div className={entry.critic?.verdict === "accepted" ? "ok" : "err"}>
                        critic: {entry.text}
                      </div>
                    )}
                    {entry.type === "approval" && (
                      <div className="warn">approval: {entry.text}</div>
                    )}
                    {entry.type === "system" && <div className="dim"># {entry.text}</div>}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Timeline & Replay Scrubber Tile */}
          <div className="bz-tile c12">
            <div
              className="bz-label"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <span>
                timeline · event {totalEvents > 0 ? currentIndex + 1 : 0} of {totalEvents}
              </span>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <button className="bz-btn sm" onClick={stepBackward} disabled={currentIndex <= 0}>
                  ◀ step
                </button>
                <button
                  className={`bz-btn sm ${isPlaying ? "danger" : "primary"}`}
                  onClick={togglePlay}
                  disabled={totalEvents === 0}
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <button
                  className="bz-btn sm"
                  onClick={stepForward}
                  disabled={currentIndex >= totalEvents - 1}
                >
                  step ▶
                </button>
                <div className="bz-seg" style={{ marginLeft: "6px" }}>
                  <button
                    className={`bz-btn sm ${speed === 1 ? "primary" : ""}`}
                    onClick={() => setSpeed(1)}
                  >
                    1x
                  </button>
                  <button
                    className={`bz-btn sm ${speed === 4 ? "primary" : ""}`}
                    onClick={() => setSpeed(4)}
                  >
                    4x
                  </button>
                </div>
              </div>
            </div>

            {/* Scrubber slider */}
            <div style={{ padding: "8px 0" }}>
              <input
                type="range"
                min={-1}
                max={Math.max(0, totalEvents - 1)}
                value={currentIndex}
                onChange={(e) => scrubTo(parseInt(e.target.value, 10))}
                style={{
                  width: "100%",
                  accentColor: "var(--bz-blue)",
                  cursor: "pointer",
                }}
              />
            </div>

            {/* Timeline Events / Markers */}
            <div
              style={{
                display: "flex",
                gap: "6px",
                flexWrap: "wrap",
                fontSize: "11px",
                marginTop: "4px",
              }}
            >
              {state.timeline.markers.map((marker) => (
                <span
                  key={marker.id}
                  className={`bz-chip ${
                    marker.color === "red"
                      ? "fail"
                      : marker.color === "yellow"
                        ? "warn"
                        : marker.color === "blue"
                          ? "run"
                          : "done"
                  }`}
                >
                  {marker.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <Footer />
      </div>
    </main>
  );
}
