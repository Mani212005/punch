import React, { useMemo } from "react";
import type { RoleRoutingState, SlotLaneState } from "@/lib/trace/types";
import { formatAgentDisplayName } from "./formatters";

interface RoutingCardTileProps {
  routingMap: Record<string, RoleRoutingState>;
  slots: Record<string, SlotLaneState>;
  mode?: string;
}

export default function RoutingCardTile({
  routingMap,
  slots,
  mode = "auto",
}: RoutingCardTileProps) {
  // Researcher routing is primary for the takeover board, or fallback to first available
  const routing = routingMap["researcher"] ?? routingMap["planner"] ?? Object.values(routingMap)[0];

  const researcherSlot = slots.researcher ?? slots[routing?.role ?? ""];
  const replacedAgentIds = new Set((researcherSlot?.replaced ?? []).map((r) => r.agentId));
  const activeAgentId = researcherSlot?.agentId ?? routing?.agentId;

  // Routing probabilities from the trace; when Jev only names the winner
  // (single-candidate decisions), show the slot standby list as the options.
  const probabilities = useMemo(() => {
    const routed = routing?.probabilities ?? [];
    if (routed.length >= 2) return routed;
    const seen = new Set(routed.map((p) => p.agentId));
    const standbyRows = (researcherSlot?.standby ?? [])
      .filter((s) => !seen.has(s.agentId))
      .map((s) => ({ agentId: s.agentId, probability: s.probability }));
    return [...routed, ...standbyRows];
  }, [routing, researcherSlot]);

  const difficulty = routing?.difficulty ?? "moderate";
  const confidence = routing?.confidence ? routing.confidence.toFixed(2) : "0.46";
  const provenance = routing?.provenance ?? "jev";

  return (
    <div className="bz-tile c5" style={{ gap: "6px" }}>
      <div className="bz-label">
        routing · {routing?.role ?? "researcher"} · {mode}
      </div>

      <div
        style={{
          display: "flex",
          gap: "10px",
          flexWrap: "wrap",
          fontSize: "11px",
        }}
        className="bz-mono bz-muted"
      >
        <span>difficulty {difficulty}</span>
        <span>confidence {confidence}</span>
        <span>provenance {provenance}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {probabilities.map((prob) => {
          const isReplaced = replacedAgentIds.has(prob.agentId);
          const isActive = prob.agentId === activeAgentId && !isReplaced;
          const displayName = formatAgentDisplayName(prob.agentId);
          const pct = Math.round(prob.probability * 100);

          let barClass = "ghost";
          if (isReplaced) {
            barClass = "fail";
          } else if (isActive) {
            barClass = "";
          }

          return (
            <div key={prob.agentId} className="bz-prob">
              {isReplaced ? (
                <span
                  style={{
                    textDecoration: "line-through",
                    color: "var(--bz-ink-2)",
                  }}
                >
                  {displayName}
                </span>
              ) : (
                <span style={{ fontWeight: isActive ? 700 : 400 }}>{displayName}</span>
              )}

              <div className={`bz-bar ${barClass}`}>
                <i style={{ width: `${pct}%` }} />
              </div>

              <span className="bz-num">{prob.probability.toFixed(2)}</span>
            </div>
          );
        })}
      </div>

      <div className="bz-muted" style={{ fontSize: "11px", marginTop: "2px" }}>
        Preference text Jev read: &ldquo;prefer the cheapest agent that can do the job; keep the
        strongest model for the executor.&rdquo;
      </div>
    </div>
  );
}
