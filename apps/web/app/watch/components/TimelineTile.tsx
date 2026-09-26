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

  // Rows: roles that actually have timeline spans (preferred order first).
  // Roles with no spans yet stay off the chart instead of showing fake bars.
  // When nothing has started (live run, event -1) fall back to slot roles.
  const spanRoles: string[] = [];
  {
    const seen = new Set<string>();
    PREFERRED_ROW_ORDER.forEach((r) => {
      if (spans.some((s) => s.role === r)) {
        seen.add(r);
        spanRoles.push(r);
      }
    });
    spans.forEach((s) => {
      if (!seen.has(s.role)) {
        seen.add(s.role);
        spanRoles.push(s.role);
      }
    });
  }
  const rowRoles =
    spanRoles.length > 0
      ? spanRoles
      : [
          ...PREFERRED_ROW_ORDER.filter((r) => slots[r]),
          ...Object.keys(slots).filter((r) => !PREFERRED_ROW_ORDER.includes(r)),
        ];

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

  // Kill / takeover markers share the slot.failed timestamp with the banner.
  const killMarker = markers.find((m) => m.type === "kill");
  const takeoverMarker = markers.find((m) => m.type === "takeover");
  const killElapsedMs = killMarker ? Math.max(0, killMarker.ts - safeT0) : 0;
  const killTimeStr = formatTime(killElapsedMs);
  const gapMs =
    takeover?.detectionMs ??
    (killMarker && takeoverMarker ? Math.max(0, takeoverMarker.ts - killMarker.ts) : 0);
  const gapSec = (gapMs / 1000).toFixed(1);

  // Per-role agent lanes: sequential spans of one role are chained end-to-start
  // (the reducer only stamps starts; run.finished closes everything), and the
  // failed predecessor is clipped + failed at the kill timestamp it shares
  // with the banner. Each agent gets its own sub-lane so a takeover reads as
  // two stacked bars instead of one overlapping smear.
  interface LaneSpan extends TimelineSpan {
    renderEnd: number;
    renderFailed: boolean;
  }
  interface RoleRow {
    role: string;
    lanes: { agentId: string; spans: LaneSpan[]; tools: TimelineSpan[] }[];
  }
  const LANE_H = 18;
  const ROW_PAD = 12;
  const rows: RoleRow[] = rowRoles.map((role) => {
    const agentSpans = spans
      .filter((s) => s.role === role && s.type === "agent")
      .sort((a, b) => a.startTs - b.startTs);
    const lanes: RoleRow["lanes"] = [];
    agentSpans.forEach((span, idx) => {
      const nextStart = agentSpans[idx + 1]?.startTs;
      let renderEnd = Math.min(span.endTs ?? safeT1, nextStart ?? safeT1);
      if (renderEnd < span.startTs) renderEnd = span.startTs;
      let renderFailed = span.status === "failed";
      if (
        takeover &&
        killMarker &&
        span.role === takeover.role &&
        span.agentId === takeover.failedAgentId &&
        span.startTs <= killMarker.ts &&
        killMarker.ts <= renderEnd
      ) {
        renderEnd = killMarker.ts;
        renderFailed = true;
      }
      let lane = lanes.find((l) => l.agentId === span.agentId);
      if (!lane) {
        lane = { agentId: span.agentId, spans: [], tools: [] };
        lanes.push(lane);
      }
      lane.spans.push({ ...span, renderEnd, renderFailed });
    });
    spans
      .filter((s) => s.role === role && s.type === "tool")
      .forEach((tool) => {
        let lane = lanes.find((l) => l.agentId === tool.agentId);
        if (!lane) {
          lane = { agentId: tool.agentId, spans: [], tools: [] };
          lanes.push(lane);
        }
        lane.tools.push(tool);
      });
    return { role, lanes };
  });
  const rowHeights = rows.map((r) => ROW_PAD + Math.max(1, r.lanes.length) * LANE_H);
  const rowY: number[] = [];
  rows.reduce((y, _, i) => {
    rowY.push(y);
    return y + rowHeights[i];
  }, TOP_PAD);
  const plotH = rowHeights.reduce((a, b) => a + b, 0);
  const viewH = TOP_PAD + plotH + AXIS_PAD;
  const axisY = TOP_PAD + plotH;

  const capStr = formatTime(budgetMsMax ?? safeT1 - safeT0);

  // Now cursor: event timestamp when known, otherwise index ratio.
  const nowX =
    nowTs !== undefined && Number.isFinite(nowTs)
      ? x(nowTs)
      : PLOT_X +
        (totalEvents > 1 ? Math.min(1, Math.max(0, currentIndex / (totalEvents - 1))) : 1) * PLOT_W;
  const nowElapsed = nowTs !== undefined ? Math.max(0, nowTs - safeT0) : 0;
  const nowTimeStr = formatTime(nowElapsed);
  const nowAnchor = nowX > PLOT_X + PLOT_W - 70 ? "end" : "middle";
  // The cursor line always renders; its text label hides when it would
  // collide with the cap label (replay at the final event).
  const showNowLabel = PLOT_X + PLOT_W - nowX > 60;

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
          {rows.map((row, rowIdx) => {
            const baseY = rowY[rowIdx];
            return (
              <g key={`row-${row.role}`}>
                <text x="6" y={baseY + 12} fontSize="10">
                  {row.role}
                </text>
                {row.lanes.map((lane, laneIdx) => {
                  const laneY = baseY + laneIdx * LANE_H;
                  return (
                    <g key={`lane-${row.role}-${lane.agentId}`}>
                      {lane.spans.map((span) => {
                        const barX = x(span.startTs);
                        const barW = Math.max(3, x(span.renderEnd) - barX);
                        const label =
                          span.label ||
                          `${span.agentId}${span.subtaskId ? ` · ${span.subtaskId}` : ""}`;
                        const fill = span.renderFailed ? "#E4321B" : spanFill(span.status);
                        return (
                          <g key={span.id}>
                            <rect x={barX} y={laneY} width={barW} height="13" fill={fill} />
                            {barW > 64 && (
                              <text x={barX + 6} y={laneY + 10} fontSize="9" className="inv">
                                {label}
                              </text>
                            )}
                          </g>
                        );
                      })}
                      {lane.tools.map((tool) => {
                        const tickX = x(tool.startTs);
                        return (
                          <rect
                            key={tool.id}
                            x={tickX}
                            y={laneY + 14}
                            width={Math.max(2, x(tool.endTs ?? tool.startTs) - tickX)}
                            height="3"
                            fill="#121212"
                            opacity="0.55"
                          >
                            <title>{tool.label}</title>
                          </rect>
                        );
                      })}
                    </g>
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
          {showNowLabel && (
            <text x={nowX} y={axisY + 9} fontSize="8" className="t-blue" textAnchor={nowAnchor}>
              now {nowTimeStr}
            </text>
          )}
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
