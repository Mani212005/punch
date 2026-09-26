import React from "react";
import Link from "next/link";
import Header from "../components/Header";
import Footer from "../components/Footer";

export default function WatchPlaceholderPage() {
  return (
    <main>
      <div className="bz" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <Header />
        <div className="bz-grid">
          <div className="bz-banner c12">
            <span className="bz-glyph lg warn" style={{ marginTop: "3px" }} />
            <div>
              <div className="bz-h3">Orchestration Board Coming in Step C4</div>
              <div className="bz-muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                The live SSE stream viewer and recorded trace replay board are scheduled for
                implementation in plan.md step C4.
              </div>
            </div>
            <div className="facts">
              <div>
                <b>Scope</b>
                Slot lanes, subtask DAG graph, Jev routing bars, streaming agent logs, timeline
                scrubber.
              </div>
              <div>
                <b>Traces</b>
                Clean auto run, manual mix, tool chaos, agent takeover, and denied approval.
              </div>
              <div>
                <b>Status</b>
                Landing page and design system (C6 / C3) complete.
              </div>
            </div>
          </div>

          <div className="bz-tile c6 alt">
            <div className="bz-label">navigation</div>
            <div className="bz-h3">Return to landing page</div>
            <p className="bz-muted" style={{ fontSize: "12px" }}>
              Explore the system architecture, features, and how Punch handles agent failures.
            </p>
            <div>
              <Link
                href="/"
                className="bz-btn primary"
                style={{ textDecoration: "none", display: "inline-block" }}
              >
                Back to landing
              </Link>
            </div>
          </div>

          <div className="bz-tile ink c6">
            <div className="bz-label">repository</div>
            <div className="bz-h3">Inspect the source on GitHub</div>
            <p style={{ fontSize: "12px", opacity: 0.8 }}>
              Check progress on the engine, CLI, and multi-agent coordination system.
            </p>
            <div>
              <a
                href="https://github.com/Mani212005/punch"
                target="_blank"
                rel="noreferrer"
                className="bz-btn"
                style={{
                  background: "var(--bz-paper)",
                  color: "var(--bz-ink)",
                  textDecoration: "none",
                  display: "inline-block",
                }}
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    </main>
  );
}
