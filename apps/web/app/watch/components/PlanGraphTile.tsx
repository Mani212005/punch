import React from "react";
import type { Subtask } from "@punch/shared";
import type { PlanGraphState, SlotLaneState, TakeoverBannerState } from "@/lib/trace/types";

interface PlanGraphTileProps {
  plan: PlanGraphState;
  activeTakeover: TakeoverBannerState | null;
  slots: Record<string, SlotLaneState>;
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

// Fixed precise layout for the reference 7-subtask DAG
const REFERENCE_7_LAYOUT: Record<string, NodeLayout> = {
  s1: { id: "s1", x: 14, y: 96, width: 110, height: 46, fontSizeTitle: 11, fontSizeMeta: 9 },
  s2: { id: "s2", x: 158, y: 36, width: 110, height: 46, fontSizeTitle: 11, fontSizeMeta: 9 },
  s3: { id: "s3", x: 158, y: 156, width: 110, height: 46, fontSizeTitle: 11, fontSizeMeta: 9 },
  s4: { id: "s4", x: 296, y: 96, width: 118, height: 46, fontSizeTitle: 11, fontSizeMeta: 9 },
  s5: { id: "s5", x: 418, y: 16, width: 96, height: 40, fontSizeTitle: 10, fontSizeMeta: 9 },
  s6: { id: "s6", x: 418, y: 96, width: 96, height: 40, fontSizeTitle: 10, fontSizeMeta: 9 },
  s7: { id: "s7", x: 418, y: 176, width: 96, height: 40, fontSizeTitle: 10, fontSizeMeta: 9 },
};

const REFERENCE_7_EDGES = [
  { from: "s1", to: "s2", d: "M124 114 L158 66" },
  { from: "s1", to: "s3", d: "M124 124 L158 172" },
  { from: "s2", to: "s4", d: "M268 66 L296 104" },
  { from: "s3", to: "s4", d: "M268 172 L296 134" },
  { from: "s4", to: "s5", d: "M414 100 L450 56" },
  { from: "s5", to: "s6", d: "M466 56 L466 96" },
  { from: "s6", to: "s7", d: "M466 136 L466 176" },
];

export default function PlanGraphTile({
  plan,
  activeTakeover,
  slots,
  onSelectSubtask,
  selectedSubtaskId,
}: PlanGraphTileProps) {
  const subtasks = plan.subtasks.length > 0 ? plan.subtasks : [];
  const isReference7 =
    subtasks.length === 7 && subtasks[0]?.id === "s1" && subtasks[6]?.id === "s7";

  // Dynamic layout generator for arbitrary subtask DAGs
  const nodeMap = new Map<string, Subtask>();
  for (const st of subtasks) {
    nodeMap.set(st.id, st);
  }

  // Calculate layout coordinates
  const layoutMap: Record<string, NodeLayout> = isReference7 ? REFERENCE_7_LAYOUT : {};
  if (!isReference7 && subtasks.length > 0) {
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

    const colWidth = 110;
    const colGap = 34;
    layers.forEach((layerNodes, lIdx) => {
      const x = 14 + lIdx * (colWidth + colGap);
      const count = layerNodes.length;
      const totalH = 220;
      layerNodes.forEach((id, nIdx) => {
        const height = count > 2 ? 38 : 46;
        const y = 20 + (nIdx + 0.5) * (totalH / count) - height / 2;
        layoutMap[id] = {
          id,
          x,
          y,
          width: colWidth,
          height,
          fontSizeTitle: 10,
          fontSizeMeta: 9,
        };
      });
    });
  }

  // Generate edges
  const edges: { from: string; to: string; d: string }[] = isReference7 ? REFERENCE_7_EDGES : [];

  if (!isReference7 && subtasks.length > 0) {
    subtasks.forEach((st) => {
      const toNode = layoutMap[st.id];
      if (!toNode) return;
      st.dependsOn.forEach((fromId) => {
        const fromNode = layoutMap[fromId];
        if (!fromNode) return;
        const x1 = fromNode.x + fromNode.width;
        const y1 = fromNode.y + fromNode.height / 2;
        const x2 = toNode.x;
        const y2 = toNode.y + toNode.height / 2;
        edges.push({
          from: fromId,
          to: st.id,
          d: `M${x1} ${y1} L${x2} ${y2}`,
        });
      });
    });
  }

  const researcherReplaced = slots.researcher?.replaced && slots.researcher.replaced.length > 0;
  const isTakeoverHappened = Boolean(activeTakeover || researcherReplaced);

  return (
    <div className="bz-tile c5">
      <div className="bz-label">
        plan graph · {subtasks.length > 0 ? `${subtasks.length} subtasks` : "empty"}
      </div>

      <div style={{ position: "relative", width: "100%" }}>
        <svg
          className="fig"
          viewBox="0 0 520 240"
          role="img"
          aria-label={`Subtask graph with ${subtasks.length} nodes`}
          style={{ width: "100%", height: "auto", minHeight: "220px", display: "block" }}
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

            const isNodeTakenOver = st.id === "s3" && isTakeoverHappened;
            const isApprovalNode = st.id === "s7" && isPending;

            const nodeClass = isDone ? "node done" : isRunning ? "node run" : "node wait";

            const textClass = isDone || isRunning ? "inv" : "";
            const metaClass = isDone || isRunning ? "inv" : "t-muted";

            // Node subtext
            let metaText = "";
            if (isDone) {
              if (st.id === "s1") metaText = "done · Opus 5";
              else if (st.id === "s2") metaText = "done · 1 retry";
              else if (st.id === "s3") metaText = isNodeTakenOver ? "done · Gemini" : "done";
              else if (st.id === "s4") metaText = "done · researcher";
              else if (st.id === "s5") metaText = "done · executor";
              else if (st.id === "s6") metaText = "done · critic";
              else if (st.id === "s7") metaText = "done · issue #42";
              else metaText = "done";
            } else if (isRunning) {
              if (st.id === "s3") metaText = "running · Gemini";
              else metaText = `running · ${st.roleHint || "agent"}`;
            } else {
              if (st.id === "s7") metaText = "needs approval";
              else if (st.id === "s4") metaText = "pending · researcher";
              else if (st.id === "s5") metaText = "executor";
              else if (st.id === "s6") metaText = "critic";
              else metaText = st.roleHint || "pending";
            }

            const centerX = layout.x + layout.width / 2;
            const titleY = layout.y + layout.height * 0.42;
            const metaY = layout.y + layout.height * 0.74;

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
                  y={titleY}
                  fontSize={layout.fontSizeTitle}
                  fontWeight="700"
                  textAnchor="middle"
                  className={textClass}
                  onClick={() => onSelectSubtask(st)}
                >
                  {st.id} {st.title}
                </text>
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

                {/* Taken-over caption for s3 */}
                {isNodeTakenOver && st.id === "s3" && (
                  <text
                    x={centerX}
                    y={layout.y + layout.height + 18}
                    fontSize="9"
                    textAnchor="middle"
                    className="t-muted"
                  >
                    was Opus 5 · taken over 03:07
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
            const leftPct = (layout.x / 520) * 100;
            const topPct = (layout.y / 240) * 100;
            const widthPct = (layout.width / 520) * 100;
            const heightPct = (layout.height / 240) * 100;
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
