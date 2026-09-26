import React from "react";
import Link from "next/link";

export default function Header() {
  return (
    <header className="bz-nav">
      <div className="brand">
        <Link
          href="/"
          style={{
            textDecoration: "none",
            color: "inherit",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span className="bz-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          Punch
        </Link>
      </div>
      <nav className="links">
        <a href="#features">Features</a>
        <Link href="/watch/takeover">Watch</Link>
        <a href="#run-locally">Run locally</a>
        <a
          href="https://github.com/Mani212005/punch"
          target="_blank"
          rel="noreferrer"
          style={{ border: "2px solid var(--bz-ink)", padding: "2px 8px" }}
        >
          GitHub
        </a>
      </nav>
    </header>
  );
}
