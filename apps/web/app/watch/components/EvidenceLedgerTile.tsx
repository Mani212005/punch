"use client";

import React, { useState } from "react";
import type { ClaimLedgerItem, EvidenceLedgerItem, LogEntry } from "@/lib/trace/types";
import { formatAgentDisplayName } from "./formatters";

interface EvidenceLedgerTileProps {
  claims: Record<string, ClaimLedgerItem>;
  evidence: Record<string, EvidenceLedgerItem>;
  logs: LogEntry[];
}

function statusChipClass(status: ClaimLedgerItem["claim"]["status"]): string {
  if (status === "verified") return "done";
  if (status === "refuted") return "fail";
  if (status === "unsupported") return "warn";
  return "ghost";
}

function actorLabel(item: ClaimLedgerItem): string {
  const { role, agentId } = item.claim.author;
  return agentId ? `${formatAgentDisplayName(agentId)} · ${role}` : role;
}

export default function EvidenceLedgerTile({ claims, evidence, logs }: EvidenceLedgerTileProps) {
  const claimList = Object.values(claims).sort((a, b) => a.recordedTs - b.recordedTs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (claims[selectedId] ?? null) : null;

  const toolCallsFor = (toolName: string): LogEntry[] =>
    logs.filter((e) => e.type === "tool_call" && e.toolCall?.tool === toolName);

  return (
    <div className="bz-tile c6" style={{ gap: "8px" }} id="ledger" data-testid="evidence-ledger">
      <div className="bz-label">evidence ledger · {claimList.length} claims</div>
      {claimList.length === 0 && (
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          No claims recorded yet. Claims arrive with the reachability and impact evidence.
        </div>
      )}
      {claimList.map((item) => (
        <button
          key={item.claim.id}
          type="button"
          onClick={() => setSelectedId(selectedId === item.claim.id ? null : item.claim.id)}
          aria-expanded={selectedId === item.claim.id}
          style={{
            all: "unset",
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            cursor: "pointer",
            border: "2px solid var(--bz-ink)",
            padding: "8px 10px",
            background: selectedId === item.claim.id ? "var(--bz-paper-2)" : "var(--bz-paper)",
          }}
        >
          <span className="bz-mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>
            {item.claim.text}
          </span>
          <span style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
            <span className={`bz-chip ${statusChipClass(item.claim.status)}`}>
              {item.claim.status}
            </span>
            <span className="bz-mono bz-muted" style={{ fontSize: "10px" }}>
              {actorLabel(item)}
            </span>
          </span>
        </button>
      ))}

      {selected && (
        <div
          role="dialog"
          aria-label={`Claim ${selected.claim.id} evidence`}
          style={{
            border: "2px solid var(--bz-ink)",
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            background: "var(--bz-paper-2)",
          }}
        >
          <div className="bz-label">claim · {selected.claim.id}</div>
          <div style={{ fontSize: "13px" }}>{selected.claim.text}</div>
          <div className="bz-mono" style={{ fontSize: "11px" }}>
            who claimed it: {actorLabel(selected)}
          </div>
          <div>
            <div className="bz-label" style={{ fontSize: "9px" }}>
              evidence ({selected.claim.evidenceRefs.length})
            </div>
            {selected.claim.evidenceRefs.length === 0 && (
              <div className="bz-muted" style={{ fontSize: "12px" }}>
                No evidence cited.
              </div>
            )}
            {selected.claim.evidenceRefs.map((ref) => {
              const rec = evidence[ref];
              if (!rec) {
                return (
                  <div key={ref} className="bz-mono bz-muted" style={{ fontSize: "11px" }}>
                    {ref} · not yet recorded
                  </div>
                );
              }
              const calls = rec.evidence.tool ? toolCallsFor(rec.evidence.tool) : [];
              return (
                <div
                  key={ref}
                  style={{
                    borderTop: "1px solid var(--bz-ink-3)",
                    paddingTop: "6px",
                    marginTop: "6px",
                  }}
                >
                  <div className="bz-mono" style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
                    {rec.evidence.kind} · {rec.evidence.ref}
                  </div>
                  <div className="bz-muted" style={{ fontSize: "12px" }}>
                    {rec.evidence.excerpt}
                  </div>
                  {rec.evidence.tool && (
                    <div className="bz-mono bz-muted" style={{ fontSize: "11px" }}>
                      tool: {rec.evidence.tool}
                      {calls.length > 0 &&
                        ` · ${calls.length} call${calls.length === 1 ? "" : "s"} in the log`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <div className="bz-label" style={{ fontSize: "9px" }}>
              verification
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <span className={`bz-chip ${statusChipClass(selected.claim.status)}`}>
                {selected.claim.status}
              </span>
              <span className="bz-mono" style={{ fontSize: "11px" }}>
                {selected.claim.verifier
                  ? `verified by ${selected.claim.verifier.agentId ? `${formatAgentDisplayName(selected.claim.verifier.agentId)} · ` : ""}${selected.claim.verifier.role}`
                  : "not yet verified"}
              </span>
            </div>
            {selected.verifiedRationale && (
              <div className="bz-muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                {selected.verifiedRationale}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
