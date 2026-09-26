import React from "react";
import type { TimelineMarker, TimelineSpan } from "@/lib/trace/types";
import { formatTime } from "./formatters";

interface TimelineTileProps {
  currentIndex: number;
  totalEvents: number;
  isPlaying: boolean;
  speed: 1 | 4;
  spans?: TimelineSpan[];
  markers?: TimelineMarker[];
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onScrub: (index: number) => void;
  onSetSpeed: (speed: 1 | 4) => void;
}

export default function TimelineTile({
  currentIndex,
  totalEvents,
  isPlaying,
  speed,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onScrub,
  onSetSpeed,
}: TimelineTileProps) {
  const currentEventNum = totalEvents > 0 ? Math.max(0, currentIndex + 1) : 0;

  // Calculate now cursor X position (from 90 to 768 / 990)
  const nowRatio = totalEvents > 1 ? Math.min(1, Math.max(0, currentIndex / (totalEvents - 1))) : 1;
  const nowX = Math.round(90 + nowRatio * (768 - 90));

  // Current elapsed time display
  const currentSeconds = Math.round(nowRatio * 192); // ~ 03:12
  const nowTimeStr = formatTime(currentSeconds * 1000);

  return (
    <div className="bz-tile c12">
      <div className="bz-label">
        timeline
        {totalEvents > 0 && (
          <span className="bz-mono bz-muted" style={{ marginLeft: "8px", fontWeight: "normal" }}>
            event {currentEventNum}/{totalEvents}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" }}>
          <button
            type="button"
            className="bz-btn sm"
            onClick={onStepBackward}
            disabled={currentIndex <= 0}
            title="Step backward"
          >
            ◀ step
          </button>
          <button
            type="button"
            className={`bz-btn sm ${isPlaying ? "danger" : "primary"}`}
            onClick={onTogglePlay}
            disabled={totalEvents === 0}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="bz-btn sm"
            onClick={onStepForward}
            disabled={currentIndex >= totalEvents - 1}
            title="Step forward"
          >
            step ▶
          </button>

          <div className="bz-seg" style={{ marginLeft: "6px" }}>
            <button
              type="button"
              className={`bz-btn sm ${speed === 1 ? "primary" : ""}`}
              onClick={() => onSetSpeed(1)}
            >
              1x
            </button>
            <button
              type="button"
              className={`bz-btn sm ${speed === 4 ? "primary" : ""}`}
              onClick={() => onSetSpeed(4)}
            >
              4x
            </button>
          </div>
        </span>
      </div>

      {/* Scrubber Range Input */}
      <div style={{ padding: "4px 0 6px 0" }}>
        <input
          type="range"
          min={-1}
          max={Math.max(0, totalEvents - 1)}
          value={currentIndex}
          onChange={(e) => onScrub(parseInt(e.target.value, 10))}
          style={{
            width: "100%",
            accentColor: "var(--bz-blue)",
            cursor: "pointer",
            height: "6px",
          }}
          aria-label="Timeline event scrubber"
        />
      </div>

      {/* Inline SVG Gantt Chart */}
      <svg
        className="fig"
        viewBox="0 0 1000 140"
        role="img"
        aria-label="Timeline with the kill at 03:07 and the takeover 1.8 seconds later"
        style={{ width: "100%", height: "auto" }}
      >
        {/* Planner Row */}
        <text x="6" y="24" fontSize="10">
          planner
        </text>
        <rect x="90" y="14" width="70" height="14" fill="#121212" />

        {/* Researcher Row */}
        <text x="6" y="50" fontSize="10">
          researcher
        </text>
        {/* Opus 5 Predecessor Bar */}
        <rect x="165" y="40" width="360" height="14" fill="#121212" />
        <text x="171" y="51" fontSize="9" className="inv">
          Opus 5 · s1 s2 s3
        </text>

        {/* Kill Marker (6px red bar) */}
        <rect x="525" y="40" width="6" height="14" fill="#E4321B" />

        {/* Gemini Flash Replacement Bar */}
        <rect x="548" y="40" width="220" height="14" fill="#1F48C5" />
        <text x="554" y="51" fontSize="9" className="inv">
          Gemini Flash · s3 resumed
        </text>

        {/* Detection Gap Red Hairline & Duration */}
        <line x1="531" y1="62" x2="548" y2="62" stroke="#E4321B" strokeWidth="2" />
        <text x="540" y="75" fontSize="9" textAnchor="middle" className="t-red">
          1.8s
        </text>

        {/* Executor Row */}
        <text x="6" y="96" fontSize="10">
          executor
        </text>
        <rect
          x="770"
          y="86"
          width="120"
          height="14"
          fill="none"
          stroke="#A39E93"
          strokeWidth="2"
          strokeDasharray="4 3"
        />

        {/* Critic Row */}
        <text x="6" y="122" fontSize="10">
          critic
        </text>
        <rect
          x="895"
          y="112"
          width="90"
          height="14"
          fill="none"
          stroke="#A39E93"
          strokeWidth="2"
          strokeDasharray="4 3"
        />

        {/* Baseline Axis */}
        <line x1="90" y1="132" x2="990" y2="132" stroke="#121212" strokeWidth="2" />

        {/* Time Axis Labels */}
        <text x="90" y="139" fontSize="8" className="t-muted">
          00:00
        </text>
        <text x="530" y="139" fontSize="8" className="t-red" textAnchor="middle">
          03:07 kill
        </text>
        <text x={nowX} y="139" fontSize="8" className="t-blue" textAnchor="middle">
          now {nowTimeStr}
        </text>
        <text x="990" y="139" fontSize="8" className="t-muted" textAnchor="end">
          08:00 cap
        </text>

        {/* Vertical Blue "Now" Cursor */}
        <line
          x1={nowX}
          y1="6"
          x2={nowX}
          y2="132"
          stroke="#1F48C5"
          strokeWidth="2"
          strokeDasharray="5 4"
        />
      </svg>
    </div>
  );
}
