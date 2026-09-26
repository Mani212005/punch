"use client";

import React from "react";
import type { SandboxRunResult } from "@punch/shared";
import type { SandboxRunBoardState } from "@/lib/trace/types";

interface SandboxTileProps {
  sandboxRuns: Record<string, SandboxRunBoardState>;
}

function stepWord(status: string): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "skipped") return "SKIPPED";
  return "NOT RUN";
}

function RunResultView({
  label,
  run,
}: {
  label: string;
  run: SandboxRunResult | null | undefined;
}) {
  if (!run) {
    return (
      <div>
        <div className="bz-label" style={{ fontSize: "9px" }}>
          {label}
        </div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          no result yet
        </div>
      </div>
    );
  }
  return (
    <div style={{ minWidth: 0 }}>
      <div className="bz-label" style={{ fontSize: "9px" }}>
        {label}
      </div>
      <div className="bz-mono" style={{ fontSize: "11px" }}>
        install {stepWord(run.install.status)} · build {stepWord(run.build.status)} · test{" "}
        {stepWord(run.test.status)}
      </div>
      {run.counts && (
        <div className="bz-num" style={{ fontSize: "12px" }}>
          tests {run.counts.passed}/{run.counts.total} pass
          {run.counts.failed > 0 && ` · ${run.counts.failed} failed`}
        </div>
      )}
      {run.failingTests.length > 0 && (
        <div className="bz-mono" style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
          failing: {run.failingTests.join(", ")}
        </div>
      )}
    </div>
  );
}

function verdictChipClass(verdict: string): string {
  if (verdict === "PASS") return "done";
  if (verdict === "FAIL") return "fail";
  return "warn";
}

export default function SandboxTile({ sandboxRuns }: SandboxTileProps) {
  const runs = Object.values(sandboxRuns).sort((a, b) => a.startedTs - b.startedTs);

  return (
    <div
      className="bz-tile c6"
      style={{ gap: "8px" }}
      id="sandbox"
      data-testid="sandbox-validation"
    >
      <div className="bz-label">sandbox validation · {runs.length} runs</div>
      {runs.length === 0 && (
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          No sandbox runs yet. The validator installs, builds and tests the candidate upgrade in
          isolation and records baseline vs candidate here.
        </div>
      )}
      {runs.map((run) => (
        <div
          key={run.findingId}
          style={{
            border: "2px solid var(--bz-ink)",
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
          data-testid={`sandbox-${run.findingId}`}
        >
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
            <span className="bz-mono" style={{ fontSize: "12px", overflowWrap: "anywhere" }}>
              {run.dependency} {run.from} → {run.to}
            </span>
            <span className="bz-chip">isolation {run.isolation}</span>
            {run.validation && (
              <span className={`bz-chip ${verdictChipClass(run.validation.verdict)}`}>
                {run.validation.verdict}
              </span>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: "8px",
            }}
          >
            <RunResultView label="baseline" run={run.validation?.baseline} />
            <RunResultView label="candidate" run={run.validation?.candidate} />
          </div>
          {run.validation && run.validation.newFailures.length > 0 && (
            <div className="bz-mono" style={{ fontSize: "11px", overflowWrap: "anywhere" }}>
              new failures: {run.validation.newFailures.join(", ")}
            </div>
          )}
          {run.validation?.note && (
            <div className="bz-muted" style={{ fontSize: "12px" }}>
              {run.validation.note}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
