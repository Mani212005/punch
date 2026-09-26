import React, { useState } from "react";
import type { EventSourceConfig } from "@/lib/trace";

interface ReplayPickerProps {
  sourceConfig: EventSourceConfig;
  onSelectStaticTrace: (traceId: string) => void;
  onUploadFile: (file: File) => void;
  onConnectLive: (engineUrl: string, token: string) => void;
  loading: boolean;
  error: Error | null;
}

const COMMITTED_TRACES = [
  { id: "takeover", name: "Takeover Run" },
  { id: "clean", name: "Clean Run" },
];

export default function ReplayPicker({
  sourceConfig,
  onSelectStaticTrace,
  onUploadFile,
  onConnectLive,
  loading,
  error,
}: ReplayPickerProps) {
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [liveEngineUrl, setLiveEngineUrl] = useState("http://localhost:4141");
  const [liveToken, setLiveToken] = useState("");

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
    </div>
  );
}
