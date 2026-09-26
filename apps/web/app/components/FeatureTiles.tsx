import React from "react";
import Link from "next/link";

export default function FeatureTiles() {
  return (
    <>
      <div className="bz-tile alt c4" id="features">
        <div className="bz-label">planning and delegation</div>
        <div style={{ fontSize: "12px" }}>
          Subtask DAG with dependencies; Jev picks per role with visible probabilities.
        </div>
        <Link href="/watch/clean-run#00:04" className="bz-mono">
          see 00:04 · clean run
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">real tools, real failures</div>
        <div style={{ fontSize: "12px" }}>
          OSV, npm, GitHub. Retries, fallbacks, degraded sections instead of crashes.
        </div>
        <Link href="/watch/chaos-run#00:41" className="bz-mono">
          see 00:41 · chaos run
        </Link>
      </div>

      <div className="bz-tile yellow c4">
        <div className="bz-label">agent takeover</div>
        <div style={{ fontSize: "12px", fontWeight: 700 }}>
          Kill the researcher. A standby resumes with 5 cached results in 1.8s.
        </div>
        <Link href="/watch/takeover#01:12" className="bz-mono">
          see 01:12 · takeover run
        </Link>
      </div>

      <div className="bz-tile alt c4" id="audit-trail">
        <div className="bz-label">audit trail</div>
        <div style={{ fontSize: "12px" }}>
          Append-only JSONL: who did what, with which inputs, and why it was chosen.
        </div>
        <Link href="/watch/takeover#00:00" className="bz-mono">
          open any trace
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">budgets and stopping</div>
        <div style={{ fontSize: "12px" }}>
          Steps, measured dollars, wall clock. A wrap-up turn when a cap hits.
        </div>
        <Link href="/watch/chaos-run#02:30" className="bz-mono">
          see 02:30 · chaos run
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">human approval</div>
        <div style={{ fontSize: "12px" }}>
          Filing the issue waits for you. No auto-approve flag exists.
        </div>
        <Link href="/watch/denial-run#03:05" className="bz-mono">
          see 03:05 · denial run
        </Link>
      </div>
    </>
  );
}
