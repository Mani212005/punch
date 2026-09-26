import React, { useState } from "react";
import type { EventSourceConfig } from "@/lib/trace";
import { parseViewerUrl } from "@/lib/trace";

interface ReplayPickerProps {
  sourceConfig: EventSourceConfig;
  onSelectStaticTrace: (traceId: string) => void;
  onUploadFile: (file: File) => void;
  onConnectLive: (engineUrl: string, token: string) => void;
  onConnectViewer: (engineBase: string, runId: string, viewerToken: string) => void;
  loading: boolean;
  error: Error | null;
}

const COMMITTED_TRACES = [
  { id: "investigation", name: "Investigation Run" },
  { id: "takeover", name: "Takeover Run" },
  { id: "clean", name: "Clean Run" },
];

export default function ReplayPicker({
  sourceConfig,
  onSelectStaticTrace,
  onUploadFile,
  onConnectLive,
  onConnectViewer,
  loading,
  error,
}: ReplayPickerProps) {
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [liveEngineUrl, setLiveEngineUrl] = useState("http://localhost:4141");
  const [liveToken, setLiveToken] = useState("");
  const [showViewerModal, setShowViewerModal] = useState(false);
  const [viewerUrl, setViewerUrl] = useState("");
  const [viewerRunId, setViewerRunId] = useState("");
  const [viewerToken, setViewerToken] = useState("");
  const [viewerError, setViewerError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadFile(file);
    }
  };

  const handleLiveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnectLive(liveEngineUrl, liveToken);
    setShowLiveModal(false);
  };

  const handleViewerUrlPaste = (value: string) => {
    setViewerUrl(value);
    // Prefill the run and token fields from the pasted URL; the viewer can still edit them.
    const parsed = parseViewerUrl(value);
    if (parsed.token) setViewerToken(parsed.token);
    if (parsed.runId) setViewerRunId(parsed.runId);
    setViewerError(null);
  };

  const handleViewerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // A pasted viewer URL wins: parse engine base, run id, and token from it.
    // Otherwise fall back to the individual fields.
    const pasted = parseViewerUrl(viewerUrl);
    const engineBase = pasted.engineBase || viewerUrl.trim().replace(/\/$/, "");
    const runId = pasted.runId || viewerRunId.trim();
    const token = pasted.token || viewerToken.trim();
    if (!engineBase) {
      setViewerError("Paste the viewer URL printed by `punch serve --tunnel`.");
      return;
    }
    if (!runId) {
      setViewerError("Enter the run id to watch (the engine operator reads it from `punch run`).");
      return;
    }
    if (!token) {
      setViewerError("The viewer URL must carry the viewer token (`?token=...`).");
      return;
    }
    setViewerError(null);
    onConnectViewer(engineBase, runId, token);
    setShowViewerModal(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div
        className="bz-nav"
        style={{
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px",
          padding: "8px 12px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <span className="bz-label">trace source:</span>
          <div className="bz-seg">
            {COMMITTED_TRACES.map((trace) => {
              const isSelected =
                sourceConfig.kind === "static" && sourceConfig.traceId === trace.id;
              return (
                <button
                  key={trace.id}
                  type="button"
                  className={`bz-btn sm ${isSelected ? "primary" : ""}`}
                  onClick={() => onSelectStaticTrace(trace.id)}
                >
                  {trace.name}
                </button>
              );
            })}

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
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
            </label>

            <button
              type="button"
              className={`bz-btn sm ${sourceConfig.kind === "sse" ? "primary" : ""}`}
              onClick={() => setShowLiveModal(true)}
            >
              Connect Live SSE
            </button>

            <button
              type="button"
              className={`bz-btn sm ${sourceConfig.kind === "viewer-tunnel" ? "primary" : ""}`}
              onClick={() => setShowViewerModal(true)}
            >
              Watch via Viewer URL
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
          {sourceConfig.kind === "viewer-tunnel" && (
            <span className="bz-mono bz-muted">
              viewer: {sourceConfig.engineBase}/runs/{sourceConfig.runId} (read-only)
            </span>
          )}
        </div>
      </div>

      {/* Live SSE Modal */}
      {showLiveModal && (
        <div
          className="bz-tile yellow c12"
          style={{
            position: "relative",
            border: "2px solid var(--bz-ink)",
            padding: "16px",
          }}
        >
          <div className="bz-label">connect to local engine or tunnel URL</div>
          <form
            onSubmit={handleLiveSubmit}
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
              }}
            >
              <div>
                <label className="bz-label">engine url / viewer url</label>
                <input
                  className="bz-input"
                  value={liveEngineUrl}
                  onChange={(e) => setLiveEngineUrl(e.target.value)}
                  placeholder="http://localhost:4141"
                />
              </div>
              <div>
                <label className="bz-label">pairing / viewer token</label>
                <input
                  className="bz-input"
                  value={liveToken}
                  onChange={(e) => setLiveToken(e.target.value)}
                  placeholder="bearer token"
                />
              </div>
            </div>
            <div
              style={{
                display: "flex",
                gap: "8px",
                justifyContent: "flex-end",
              }}
            >
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
      {/* Viewer URL Modal (read-only remote watching through a tunnel) */}
      {showViewerModal && (
        <div
          className="bz-tile yellow c12"
          style={{
            position: "relative",
            border: "2px solid var(--bz-ink)",
            padding: "16px",
          }}
        >
          <div className="bz-label">watch a live run through a tunnel (read-only)</div>
          <p className="bz-mono bz-muted" style={{ fontSize: "12px" }}>
            Paste the viewer URL printed by `punch serve --tunnel`. It carries only the viewer
            token: you can watch the run, including takeovers, but Kill, Approve, and Stop stay
            hidden.
          </p>
          <form
            onSubmit={handleViewerSubmit}
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div>
              <label className="bz-label" htmlFor="viewer-url">
                viewer url
              </label>
              <input
                id="viewer-url"
                className="bz-input"
                value={viewerUrl}
                onChange={(e) => handleViewerUrlPaste(e.target.value)}
                placeholder="https://abc-123.trycloudflare.com/?token=..."
              />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
              }}
            >
              <div>
                <label className="bz-label" htmlFor="viewer-run-id">
                  run id
                </label>
                <input
                  id="viewer-run-id"
                  className="bz-input"
                  value={viewerRunId}
                  onChange={(e) => setViewerRunId(e.target.value)}
                  placeholder="2026-09-26-takeover"
                />
              </div>
              <div>
                <label className="bz-label" htmlFor="viewer-token">
                  viewer token
                </label>
                <input
                  id="viewer-token"
                  className="bz-input"
                  value={viewerToken}
                  onChange={(e) => setViewerToken(e.target.value)}
                  placeholder="viewer token (filled from the URL)"
                />
              </div>
            </div>
            {viewerError && <span className="bz-chip fail">{viewerError}</span>}
            <div
              style={{
                display: "flex",
                gap: "8px",
                justifyContent: "flex-end",
              }}
            >
              <button type="button" className="bz-btn sm" onClick={() => setShowViewerModal(false)}>
                Cancel
              </button>
              <button type="submit" className="bz-btn primary sm">
                Watch Stream
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
