import React from "react";
import type { Subtask } from "@punch/shared";
import type {
  PlanGraphState,
  SlotLaneState,
  TakeoverBannerState,
  TimelineSpan,
} from "@/lib/trace/types";
import { formatAgentDisplayName, formatTime } from "./formatters";

interface PlanGraphTileProps {
  plan: PlanGraphState;
  activeTakeover: TakeoverBannerState | null;
  slots: Record<string, SlotLaneState>;
  spans?: TimelineSpan[];
  runStartTime?: number;
  onSelectSubtask: (subtask: Subtask) => void;
  selectedSubtaskId?: string | null;
}

interface NodeLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizeTitle: number;
  fontSizeMeta: number;
}

/** Wrap a title into short lines so SVG labels never truncate silently. */
export function wrapNodeTitle(title: string, maxChars = 16, maxLines = 2): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChars && current === "") {
      lines.push(word);
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

export default function PlanGraphTile({
  plan,
  activeTakeover,
  slots,
  spans = [],
  runStartTime,
  onSelectSubtask,
  selectedSubtaskId,
}: PlanGraphTileProps) {
  const subtasks = plan.subtasks.length > 0 ? plan.subtasks : [];

  // Dynamic layout generator for arbitrary subtask DAGs
  const nodeMap = new Map<string, Subtask>();
  for (const st of subtasks) {
    nodeMap.set(st.id, st);
  }

  // Calculate layout coordinates
  const layoutMap: Record<string, NodeLayout> = {};
  if (subtasks.length > 0) {
    // Determine topological layers
    const layerMap = new Map<string, number>();
    const getLayer = (id: string, visited = new Set<string>()): number => {
      if (layerMap.has(id)) return layerMap.get(id)!;
      if (visited.has(id)) return 0;
      visited.add(id);
      const st = nodeMap.get(id);
      if (!st || st.dependsOn.length === 0) {
        layerMap.set(id, 0);
        return 0;
      }
      const maxDep = Math.max(...st.dependsOn.map((d) => getLayer(d, visited)));
      const layer = maxDep + 1;
      layerMap.set(id, layer);
      return layer;
    };

    subtasks.forEach((st) => getLayer(st.id));

    // Group by layer
    const layers: string[][] = [];
    subtasks.forEach((st) => {
      const l = layerMap.get(st.id) ?? 0;
      if (!layers[l]) layers[l] = [];
      layers[l].push(st.id);
    });

    // Top-down layers keep the graph narrow enough to fit the tile at ~1:1 scale, so
    // labels stay readable at desktop and phone width instead of shrinking with the SVG.
    const nodeWidth = 118;
    const nodeHeight = 62;
    const colGap = 14;
    const rowStep = nodeHeight + 38;
    const maxPerLayer = Math.max(...layers.map((l) => l?.length ?? 0));
    const fullWidth = maxPerLayer * nodeWidth + (maxPerLayer - 1) * colGap;
    layers.forEach((layerNodes, lIdx) => {
      const count = layerNodes.length;
      const rowWidth = count * nodeWidth + (count - 1) * colGap;
      const startX = 8 + (fullWidth - rowWidth) / 2;
      layerNodes.forEach((id, nIdx) => {
        layoutMap[id] = {
          id,
          x: startX + nIdx * (nodeWidth + colGap),
          y: 8 + lIdx * rowStep,
          width: nodeWidth,
          height: nodeHeight,
          fontSizeTitle: 11,
          fontSizeMeta: 9,
        };
      });
    });
  }

  // Generate edges from dependencies against the final node layout, so edges
  // always meet the nodes even when node sizes change.
  const edges: { from: string; to: string; d: string }[] = [];

  if (subtasks.length > 0) {
    subtasks.forEach((st) => {
      const toNode = layoutMap[st.id];
      if (!toNode) return;
      st.dependsOn.forEach((fromId) => {
        const fromNode = layoutMap[fromId];
        if (!fromNode) return;
        const x1 = fromNode.x + fromNode.width / 2;
        const y1 = fromNode.y + fromNode.height;
        const x2 = toNode.x + toNode.width / 2;
        const y2 = toNode.y;
        edges.push({
          from: fromId,
          to: st.id,
          d: `M${x1} ${y1} C${x1} ${y1 + 18} ${x2} ${y2 - 18} ${x2} ${y2}`,
        });
      });
    });
  }

  // Taken-over caption time: the slot.failed timestamp the banner and kill marker use.
  const failedTs = activeTakeover ? activeTakeover.ts - (activeTakeover.detectionMs ?? 0) : 0;
  const takenOverTime =
    activeTakeover && runStartTime ? formatTime(Math.max(0, failedTs - runStartTime)) : null;

  // Size the SVG to its content so the graph never leaves large empty space.
  const contentWidth =
    subtasks.length > 0
      ? Math.max(
          ...subtasks.map((st) => (layoutMap[st.id]?.x ?? 0) + (layoutMap[st.id]?.width ?? 0)),
        ) + 8
      : 240;
  const contentHeight =
    subtasks.length > 0
      ? Math.max(
          ...subtasks.map((st) => (layoutMap[st.id]?.y ?? 0) + (layoutMap[st.id]?.height ?? 0)),
        ) + 26
      : 120;

  return (
    <div className="bz-tile c5">
      <div className="bz-label">
        plan graph · {subtasks.length > 0 ? `${subtasks.length} subtasks` : "empty"}
      </div>

      <div style={{ position: "relative", width: "100%" }}>
        <svg
          className="fig"
          viewBox={`0 0 ${contentWidth} ${contentHeight}`}
          role="img"
          aria-label={`Subtask graph with ${subtasks.length} nodes`}
          style={{ width: "100%", height: "auto", display: "block" }}
        >
          <defs>
            <marker
              id="bzarr"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#121212" />
            </marker>
          </defs>

          {/* Render Edges */}
          {edges.map((edge, idx) => (
            <path
              key={`edge-${edge.from}-${edge.to}-${idx}`}
              className="edge"
              d={edge.d}
              markerEnd="url(#bzarr)"
            />
          ))}

          {/* Render Nodes */}
          {subtasks.map((st) => {
            const layout = layoutMap[st.id] || {
              id: st.id,
              x: 20,
              y: 20,
              width: 100,
              height: 40,
              fontSizeTitle: 10,
              fontSizeMeta: 9,
            };

            const isSelected = selectedSubtaskId === st.id;
            const isDone = st.status === "completed";
            const isRunning = st.status === "running";
            const isFailed = st.status === "failed" || st.status === "degraded";
            const isPending = !isDone && !isRunning && !isFailed;

            // Agent working this subtask: the latest producer span for it
            // (critic review spans don't count; a replacement wins over the
            // predecessor), falling back to slot state.
            const agentSpansForNode = spans
              .filter((s) => s.type === "agent" && s.subtaskId === st.id)
              .sort((a, b) => a.startTs - b.startTs);
            const spanWorker =
              agentSpansForNode.filter((s) => s.role !== "critic").at(-1)?.agentId ??
              agentSpansForNode.at(-1)?.agentId;
            const slotWorker = Object.values(slots).find(
              (s) => s.currentSubtaskId === st.id,
            )?.agentId;
            const workerAgentId = spanWorker ?? slotWorker;
            const workerName = workerAgentId ? formatAgentDisplayName(workerAgentId) : null;

            const isNodeTakenOver = activeTakeover?.subtaskId === st.id;
            const isApprovalNode = st.id === "s7" && isPending;

            const nodeClass = isDone ? "node done" : isRunning ? "node run" : "node wait";

            const textClass = isDone || isRunning ? "inv" : "";
            const metaClass = isDone || isRunning ? "inv" : "t-muted";

            // Node subtext, derived from subtask status, role hint, and slot state.
            let metaText = "";
            if (isDone) {
              metaText = workerName ? `done · ${workerName}` : "done";
            } else if (isRunning) {
              metaText = `running · ${workerName ?? st.roleHint ?? "agent"}`;
            } else if (isFailed) {
              metaText = `failed · ${workerName ?? st.roleHint ?? "agent"}`;
            } else {
              metaText = st.roleHint || "pending";
            }

            const centerX = layout.x + layout.width / 2;
            // Wrapped title lines (never truncated) sit between the id and the meta line.
            const titleLines = wrapNodeTitle(st.title, 15, 2);
            const idY = layout.y + 12;
            const titleStartY = layout.y + 26;
            const titleStep = layout.fontSizeTitle + 3;
            const metaY = layout.y + layout.height - 6;

            return (
              <g
                key={st.id}
                onClick={() => onSelectSubtask(st)}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={`Subtask ${st.id} ${st.title} - ${st.status}`}
              >
                <rect
                  className={nodeClass}
                  x={layout.x}
                  y={layout.y}
                  width={layout.width}
                  height={layout.height}
                  stroke={isApprovalNode ? "#F5C518" : isSelected ? "var(--bz-blue)" : undefined}
                  strokeWidth={isSelected ? 3 : undefined}
                  onClick={() => onSelectSubtask(st)}
                />
                <text
                  x={centerX}
                  y={idY}
                  fontSize={layout.fontSizeMeta}
                  fontWeight="700"
                  textAnchor="middle"
                  className={textClass}
                  onClick={() => onSelectSubtask(st)}
                >
                  {st.id}
                  <title>{`${st.id} · ${st.title}`}</title>
                </text>
                {titleLines.map((line, lineIdx) => (
                  <text
                    key={`${st.id}-title-${lineIdx}`}
                    x={centerX}
                    y={titleStartY + lineIdx * titleStep}
                    fontSize={layout.fontSizeTitle}
                    fontWeight="700"
                    textAnchor="middle"
                    className={textClass}
                    onClick={() => onSelectSubtask(st)}
                  >
                    {line}
                  </text>
                ))}
                <text
                  x={centerX}
                  y={metaY}
                  fontSize={layout.fontSizeMeta}
                  textAnchor="middle"
                  className={metaClass}
                  onClick={() => onSelectSubtask(st)}
                >
                  {metaText}
                </text>

                {/* Taken-over caption under the replaced subtask node */}
                {isNodeTakenOver && (
                  <text
                    x={layout.x}
                    y={layout.y + layout.height + 14}
                    fontSize="9"
                    textAnchor="start"
                    className="t-muted"
                    stroke="var(--bz-paper)"
                    strokeWidth="3"
                    paintOrder="stroke"
                  >
                    was {formatAgentDisplayName(activeTakeover?.failedAgentId)}
                    {takenOverTime ? ` · ${takenOverTime}` : " · taken over"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Accessible overlay buttons */}
        <div style={{ position: "absolute", inset: 0 }}>
          {subtasks.map((st) => {
            const layout = layoutMap[st.id];
            if (!layout) return null;
            const leftPct = (layout.x / contentWidth) * 100;
            const topPct = (layout.y / contentHeight) * 100;
            const widthPct = (layout.width / contentWidth) * 100;
            const heightPct = (layout.height / contentHeight) * 100;
            return (
              <button
                key={`btn-overlay-${st.id}`}
                type="button"
                onClick={() => onSelectSubtask(st)}
                style={{
                  position: "absolute",
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${widthPct}%`,
                  height: `${heightPct}%`,
                  opacity: 0,
                  cursor: "pointer",
                  margin: 0,
                  padding: 0,
                  border: 0,
                  background: "transparent",
                }}
                aria-label={`Inspect subtask ${st.id} ${st.title}`}
              >
                {st.id} {st.title}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
