import React from "react";
import type {
  BoardRunState,
  SlotLaneState,
  TakeoverBannerState,
  TimelineMarker,
  TimelineSpan,
} from "@/lib/trace/types";
import { formatTime } from "./formatters";

interface TimelineTileProps {
  currentIndex: number;
  totalEvents: number;
  isPlaying: boolean;
  speed: 1 | 4;
  spans?: TimelineSpan[];
  markers?: TimelineMarker[];
  slots?: Record<string, SlotLaneState>;
  run?: BoardRunState;
  budgetMsMax?: number;
  nowTs?: number;
  takeover?: TakeoverBannerState | null;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onScrub: (index: number) => void;
  onSetSpeed: (speed: 1 | 4) => void;
}

const PLOT_X = 90;
const PLOT_W = 900;
const VIEW_W = 1000;
const ROW_H = 30;
const TOP_PAD = 14;
const AXIS_PAD = 34;

const PREFERRED_ROW_ORDER = ["planner", "researcher", "executor", "critic"];

function spanFill(status: TimelineSpan["status"]): string {
  if (status === "running") return "#1F48C5";
  if (status === "failed") return "#E4321B";
  return "#121212";
}

export default function TimelineTile({
  currentIndex,
  totalEvents,
  isPlaying,
  speed,
  spans = [],
  markers = [],
  slots = {},
  run,
  budgetMsMax,
  nowTs,
  takeover,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onScrub,
  onSetSpeed,
}: TimelineTileProps) {
  const currentEventNum = totalEvents > 0 ? Math.max(0, currentIndex + 1) : 0;

  // Rows: preferred role order first, then any other roles seen in spans or slots.
  const rowRoles: string[] = [];
  PREFERRED_ROW_ORDER.forEach((r) => {
    if (spans.some((s) => s.role === r) || slots[r]) rowRoles.push(r);
  });
  const seen = new Set(rowRoles);
  spans.forEach((s) => {
    if (!seen.has(s.role)) {
      seen.add(s.role);
      rowRoles.push(s.role);
    }
  });
  Object.keys(slots).forEach((r) => {
    if (!seen.has(r)) {
      seen.add(r);
      rowRoles.push(r);
    }
  });

  // Time domain: full run so the frame is stable while scrubbing.
  const spanTimes = spans.flatMap((s) => [s.startTs, s.endTs ?? s.startTs]);
  const markerTimes = markers.map((m) => m.ts);
  const t0 = run?.startTime ?? Math.min(nowTs ?? Infinity, ...spanTimes, ...markerTimes);
  const domainEnd = Math.max(
    run?.endTime ?? -Infinity,
    nowTs ?? -Infinity,
    ...spanTimes,
    ...markerTimes,
  );
  const safeT0 = Number.isFinite(t0) ? (t0 as number) : 0;
  const safeT1 = Number.isFinite(domainEnd) && domainEnd > safeT0 ? domainEnd : safeT0 + 1000;
  const x = (ts: number) => PLOT_X + (Math.max(0, ts - safeT0) / (safeT1 - safeT0)) * PLOT_W;

  const viewH = TOP_PAD + rowRoles.length * ROW_H + AXIS_PAD;
  const axisY = TOP_PAD + rowRoles.length * ROW_H;

  // Now cursor: event timestamp when known, otherwise index ratio.
  const nowX =
    nowTs !== undefined && Number.isFinite(nowTs)
      ? x(nowTs)
      : PLOT_X +
        (totalEvents > 1 ? Math.min(1, Math.max(0, currentIndex / (totalEvents - 1))) : 1) * PLOT_W;
  const nowElapsed = nowTs !== undefined ? Math.max(0, nowTs - safeT0) : 0;
  const nowTimeStr = formatTime(nowElapsed);

  // Kill / takeover markers share the slot.failed timestamp with the banner.
  const killMarker = markers.find((m) => m.type === "kill");
  const takeoverMarker = markers.find((m) => m.type === "takeover");
  const killElapsedMs = killMarker ? Math.max(0, killMarker.ts - safeT0) : 0;
  const killTimeStr = formatTime(killElapsedMs);
  const gapMs =
    takeover?.detectionMs ??
    (killMarker && takeoverMarker ? Math.max(0, takeoverMarker.ts - killMarker.ts) : 0);
  const gapSec = (gapMs / 1000).toFixed(1);

  const capStr = formatTime(budgetMsMax ?? safeT1 - safeT0);

  return (
    <div className="bz-tile c12">
      <div className="bz-label" style={{ flexWrap: "wrap", rowGap: "8px" }}>
        {totalEvents > 0 ? `timeline · event ${currentEventNum} of ${totalEvents}` : "timeline"}
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

      {/* Horizontally scrollable SVG Gantt Chart container for mobile */}
      <div
        style={{
          width: "100%",
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <svg
          className="fig"
          viewBox={`0 0 ${VIEW_W} ${viewH}`}
          role="img"
          aria-label={`Timeline with the kill at ${killTimeStr} and the takeover ${gapSec} seconds later`}
          style={{ minWidth: "680px", width: "100%", height: "auto", display: "block" }}
        >
          {rowRoles.map((role, rowIdx) => {
            const rowY = TOP_PAD + rowIdx * ROW_H;
            const agentSpans = spans.filter((s) => s.role === role && s.type === "agent");
            const toolSpans = spans.filter((s) => s.role === role && s.type === "tool");
            return (
              <g key={`row-${role}`}>
                <text x="6" y={rowY + 16} fontSize="10">
                  {role}
                </text>
                {agentSpans.map((span) => {
                  const barX = x(span.startTs);
                  const barEnd = x(span.endTs ?? nowTs ?? span.startTs);
                  const barW = Math.max(3, barEnd - barX);
                  const label =
                    span.label || `${span.agentId}${span.subtaskId ? ` · ${span.subtaskId}` : ""}`;
                  return (
                    <g key={span.id}>
                      <rect
                        x={barX}
                        y={rowY}
                        width={barW}
                        height="14"
                        fill={spanFill(span.status)}
                      />
                      {barW > 64 && (
                        <text x={barX + 6} y={rowY + 11} fontSize="9" className="inv">
                          {label}
                        </text>
                      )}
                    </g>
                  );
                })}
                {toolSpans.map((span) => {
                  const tickX = x(span.startTs);
                  return (
                    <rect
                      key={span.id}
                      x={tickX}
                      y={rowY + 18}
                      width={Math.max(2, x(span.endTs ?? span.startTs) - tickX)}
                      height="4"
                      fill="#121212"
                      opacity="0.55"
                    >
                      <title>{span.label}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}

          {/* Kill marker: red bar at the slot.failed timestamp */}
          {killMarker && (
            <line
              x1={x(killMarker.ts)}
              y1={TOP_PAD - 6}
              x2={x(killMarker.ts)}
              y2={axisY}
              stroke="#E4321B"
              strokeWidth="4"
            />
          )}

          {/* Takeover marker: yellow bar at the slot.replacing timestamp */}
          {takeoverMarker && (
            <line
              x1={x(takeoverMarker.ts)}
              y1={TOP_PAD - 6}
              x2={x(takeoverMarker.ts)}
              y2={axisY}
              stroke="#F5C518"
              strokeWidth="3"
            />
          )}

          {/* Detection-gap hairline between kill and takeover */}
          {killMarker && takeoverMarker && (
            <g>
              <line
                x1={x(killMarker.ts)}
                y1={axisY + 12}
                x2={x(takeoverMarker.ts)}
                y2={axisY + 12}
                stroke="#E4321B"
                strokeWidth="2"
              />
              <text
                x={(x(killMarker.ts) + x(takeoverMarker.ts)) / 2}
                y={axisY + 25}
                fontSize="9"
                textAnchor="middle"
                className="t-red"
              >
                {gapSec}s
              </text>
            </g>
          )}

          {/* Finish marker */}
          {markers
            .filter((m) => m.type === "finish")
            .map((m) => (
              <line
                key={m.id}
                x1={x(m.ts)}
                y1={TOP_PAD - 6}
                x2={x(m.ts)}
                y2={axisY}
                stroke="#1F48C5"
                strokeWidth="2"
              />
            ))}

          {/* Baseline Axis */}
          <line
            x1={PLOT_X}
            y1={axisY}
            x2={PLOT_X + PLOT_W}
            y2={axisY}
            stroke="#121212"
            strokeWidth="2"
          />

          {/* Time Axis Labels */}
          <text x={PLOT_X} y={axisY + 9} fontSize="8" className="t-muted">
            00:00
          </text>
          {killMarker && (
            <text
              x={x(killMarker.ts)}
              y={axisY + 9}
              fontSize="8"
              className="t-red"
              textAnchor="middle"
            >
              {killTimeStr} kill
            </text>
          )}
          <text x={nowX} y={axisY + 9} fontSize="8" className="t-blue" textAnchor="middle">
            now {nowTimeStr}
          </text>
          <text x={PLOT_X + PLOT_W} y={axisY + 9} fontSize="8" className="t-muted" textAnchor="end">
            {capStr} cap
          </text>

          {/* Vertical Blue "Now" Cursor */}
          <line
            x1={nowX}
            y1={TOP_PAD - 6}
            x2={nowX}
            y2={axisY}
            stroke="#1F48C5"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
        </svg>
      </div>
    </div>
  );
}
