import React from "react";
import Link from "next/link";

export default function FeatureTiles() {
  return (
    <>
      <div className="bz-tile alt c4" id="features">
        <div className="bz-label">reachability, proved</div>
        <div style={{ fontSize: "12px" }}>
          Exists is not exposed is not exploitable. Call sites, routes and entrypoints decide.
        </div>
        <Link href="/watch/investigation#reachability" className="bz-mono">
          see the reachability verdict
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">upgrade impact</div>
        <div style={{ fontSize: "12px" }}>
          LOW / MEDIUM / HIGH with detected risks and unknowns. No invented percentages.
        </div>
        <Link href="/watch/investigation#impact" className="bz-mono">
          see the impact analysis
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">sandbox validation</div>
        <div style={{ fontSize: "12px" }}>
          The candidate upgrade is installed, built and tested in isolation. Baseline vs candidate.
        </div>
        <Link href="/watch/investigation#sandbox" className="bz-mono">
          see the validation run
        </Link>
      </div>

      <div className="bz-tile alt c4">
        <div className="bz-label">adversarial critic</div>
        <div style={{ fontSize: "12px" }}>
          Ten challenges try to prove each finding wrong. Rejection replans the investigation.
        </div>
        <Link href="/watch/investigation#critic" className="bz-mono">
          see the rejected verdict
        </Link>
      </div>

      <div className="bz-tile yellow c4">
        <div className="bz-label">agent takeover</div>
        <div style={{ fontSize: "12px", fontWeight: 700 }}>
          The reachability agent crashes. A standby resumes with its evidence in seconds.
        </div>
        <Link href="/watch/takeover#01:12" className="bz-mono">
          see 01:12 · takeover run
        </Link>
      </div>

      <div className="bz-tile alt c4" id="audit-trail">
        <div className="bz-label">evidence ledger + approval</div>
        <div style={{ fontSize: "12px" }}>
          Who claimed it, on what evidence, who verified it. Issues and PRs wait for a human.
        </div>
        <Link href="/watch/investigation#ledger" className="bz-mono">
          open the ledger
        </Link>
      </div>
    </>
  );
}
