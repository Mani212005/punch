import React from "react";
import type { BoardRunState, TakeoverBannerState } from "@/lib/trace/types";

interface RunTileProps {
  run: BoardRunState;
  activeTakeover: TakeoverBannerState | null;
  onStop?: () => void;
}

export default function RunTile({ run, activeTakeover, onStop }: RunTileProps) {
  const isTakeoverActive =
    run.isTakeoverInProgress || (activeTakeover !== null && activeTakeover.status === "replacing");

  const glyphClass = isTakeoverActive
    ? "warn"
    : run.status === "completed"
      ? "done"
      : run.status === "running"
        ? "run"
        : run.status === "failed" || run.status === "aborted"
          ? "fail"
          : "wait";

  const repoDisplay = run.repoUrl
    ? run.repoUrl.replace(/^https?:\/\//, "")
    : "github.com/acme/webapp";

  return (
    <div
      className="bz-tile c8"
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "10px",
      }}
    >
      <span className={`bz-glyph lg ${glyphClass}`} />
      <div>
        <div className="bz-label">run</div>
        <div className="bz-h3 bz-num" style={{ fontSize: "16px" }}>
          {run.runId || "pending-initialization"}
        </div>
      </div>
      <span className="bz-chip">{run.mode || "auto"}</span>
      <span className="bz-mono">{repoDisplay}</span>

      {isTakeoverActive ? (
        <span className="bz-chip warn" style={{ marginLeft: "auto" }}>
          takeover in progress
        </span>
      ) : (
        <span
          className={`bz-chip ${
            run.status === "completed"
              ? "done"
              : run.status === "running"
                ? "run"
                : run.status === "failed" || run.status === "aborted"
                  ? "fail"
                  : "ghost"
          }`}
          style={{ marginLeft: "auto" }}
        >
          {run.status || "pending"}
        </span>
      )}

      <button
        type="button"
        className="bz-btn danger sm"
        onClick={onStop}
        disabled={run.status === "completed" || run.status === "aborted"}
      >
        Stop
      </button>
    </div>
  );
}
