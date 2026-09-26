import React from "react";
import Link from "next/link";

export default function Hero() {
  return (
    <>
      <div className="bz-tile c8" style={{ gap: "14px", padding: "22px" }}>
        <div className="bz-label">security investigation · runs on your machine</div>
        <h1 className="bz-h1">Does this vulnerability actually matter to your repo?</h1>
        <p className="bz-lead bz-muted" style={{ maxWidth: "52ch" }}>
          Punch investigates whether a vulnerability affects your application, proves reachability,
          analyzes upgrade impact, validates fixes in isolation, challenges its own conclusions, and
          recovers when an agent fails. Every conclusion has an evidence trail; irreversible actions
          wait for your approval.
        </p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Link
            href="/watch/investigation"
            className="bz-btn primary"
            style={{ textDecoration: "none", display: "inline-block" }}
          >
            Watch the investigation run
          </Link>
          <a
            href="#features"
            className="bz-btn"
            style={{ textDecoration: "none", display: "inline-block" }}
          >
            How the investigation works
          </a>
        </div>
      </div>
      <div className="bz-tile ink c4" style={{ justifyContent: "space-between" }}>
        <div className="bz-label">source</div>
        <div className="bz-h3">github.com/Mani212005/punch</div>
        <div style={{ fontSize: "12px", opacity: 0.8 }}>
          MIT. TypeScript. Engine, CLI, and this site in one repo.
        </div>
        <a
          href="https://github.com/Mani212005/punch"
          target="_blank"
          rel="noreferrer"
          className="bz-btn"
          style={{
            background: "var(--bz-paper)",
            color: "var(--bz-ink)",
            alignSelf: "flex-start",
            textDecoration: "none",
          }}
        >
          View on GitHub
        </a>
      </div>
    </>
  );
}
