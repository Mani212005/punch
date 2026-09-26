import React from "react";
import Link from "next/link";

export default function Hero() {
  return (
    <>
      <div className="bz-tile c8" style={{ gap: "14px", padding: "22px" }}>
        <div className="bz-label">multi-agent system · runs on your machine</div>
        <h1 className="bz-h1">Agents that plan, delegate, and take over for each other.</h1>
        <p className="bz-lead bz-muted" style={{ maxWidth: "52ch" }}>
          Use the models you already pay for. Jev decides who does what. When an agent dies, the
          next one picks up its work with everything it had fetched. Every decision is in the trace.
        </p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Link
            href="/watch/takeover"
            className="bz-btn primary"
            style={{ textDecoration: "none", display: "inline-block" }}
          >
            Watch the takeover run
          </Link>
          <a
            href="#features"
            className="bz-btn"
            style={{ textDecoration: "none", display: "inline-block" }}
          >
            Read the trace format
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
