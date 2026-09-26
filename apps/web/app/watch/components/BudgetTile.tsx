import React from "react";
import type { BoardBudgetState } from "@/lib/trace/types";
import { formatTime } from "./formatters";

interface BudgetTileProps {
  budget: BoardBudgetState;
}

export default function BudgetTile({ budget }: BudgetTileProps) {
  const stepsPct =
    budget.steps.max > 0
      ? Math.min(100, Math.round((budget.steps.used / budget.steps.max) * 100))
      : 0;

  const usdPct =
    budget.usd.max > 0 ? Math.min(100, Math.round((budget.usd.used / budget.usd.max) * 100)) : 0;

  const msPct =
    budget.ms.max > 0 ? Math.min(100, Math.round((budget.ms.used / budget.ms.max) * 100)) : 0;

  const getBarClass = (pct: number, isExceeded: boolean) => {
    if (isExceeded || pct >= 100) return "fail";
    if (pct >= 80) return "warn";
    return "";
  };

  return (
    <div className="bz-tile c4" style={{ gap: "6px" }}>
      <div className="bz-label">budget · measured</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "52px minmax(0, 1fr) 70px",
          gap: "8px",
          alignItems: "center",
          fontSize: "11px",
        }}
      >
        <span className="bz-mono">steps</span>
        <div className={`bz-bar ${getBarClass(stepsPct, budget.exceeded === "steps")}`}>
          <i style={{ width: `${stepsPct}%` }} />
        </div>
        <span className="bz-num" style={{ textAlign: "right" }}>
          {budget.steps.used} / {budget.steps.max || 40}
        </span>

        <span className="bz-mono">usd</span>
        <div className={`bz-bar ${getBarClass(usdPct, budget.exceeded === "usd")}`}>
          <i style={{ width: `${usdPct}%` }} />
        </div>
        <span className="bz-num" style={{ textAlign: "right" }}>
          {budget.usd.used.toFixed(2)} / {(budget.usd.max || 2.0).toFixed(2)}
        </span>

        <span className="bz-mono">clock</span>
        <div className={`bz-bar ${getBarClass(msPct, budget.exceeded === "wallClock")}`}>
          <i style={{ width: `${msPct}%` }} />
        </div>
        <span className="bz-num" style={{ textAlign: "right" }}>
          {formatTime(budget.ms.used)} / {formatTime(budget.ms.max || 480000)}
        </span>
      </div>
    </div>
  );
}
