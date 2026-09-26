"use client";

import React, { useState } from "react";
import type { Config } from "@punch/shared";
import { DEFAULT_ENGINE_URL } from "@/lib/engine/client";

export type PairingStatus = "checking" | "paired" | "error";

interface UnpairedProps {
  error: string | null;
  busy: boolean;
  onPair: (engineUrl: string, token: string) => void;
}

/** Shown alone until an engine is paired: URL and token stay in this browser. */
export function UnpairedStrip({ error, busy, onPair }: UnpairedProps) {
  const [engineUrl, setEngineUrl] = useState(DEFAULT_ENGINE_URL);
  const [token, setToken] = useState("");
  return (
    <form
      className="bz-tile c12"
      onSubmit={(event) => {
        event.preventDefault();
        onPair(engineUrl, token);
      }}
      aria-label="pair with engine"
    >
      <div className="bz-label">
        <span className="bz-glyph wait" />
        not paired · console controls appear once an engine is paired
      </div>
      <div className="pc-pair-form">
        <label className="bz-field">
          <span className="bz-label">engine url</span>
          <input
            className="bz-input"
            name="engineUrl"
            value={engineUrl}
            onChange={(event) => setEngineUrl(event.target.value)}
            placeholder="http://localhost:4141"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="bz-field">
          <span className="bz-label">pairing token · printed by punch serve</span>
          <input
            className="bz-input"
            name="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="pairing token"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="bz-btn primary" type="submit" disabled={busy || token.trim() === ""}>
          {busy ? "Pairing" : "Pair"}
        </button>
      </div>
      {error && (
        <div className="pc-error" role="alert">
          x {error}
        </div>
      )}
      <div className="bz-mono bz-muted" style={{ fontSize: 10 }}>
        Start the engine with: punch serve --web-origin {"<this site's origin>"}
      </div>
    </form>
  );
}

interface PairedProps {
  engineUrl: string;
  status: PairingStatus;
  config: Config | null;
  configError: string | null;
  validating: boolean;
  onValidate: () => void;
  onUnpair: () => void;
}

export function PairedStrip({
  engineUrl,
  status,
  config,
  configError,
  validating,
  onValidate,
  onUnpair,
}: PairedProps) {
  const glyph = status === "paired" ? "run" : status === "error" ? "fail" : "wait";
  const host = engineUrl.replace(/^https?:\/\//, "");
  const providers = config ? new Set(config.agents.map((agent) => agent.providerId)).size : 0;
  return (
    <div className="bz-tile c12 pc-strip" data-testid="pairing-strip">
      <span className={`bz-glyph ${glyph}`} />
      <span className="bz-mono">
        {status === "error" ? "unreachable" : status === "checking" ? "checking" : "paired"} ·{" "}
        {host}
      </span>
      {config && (
        <span className="bz-chip" data-testid="config-chip">
          config valid · {config.agents.length} agents · {providers} providers
        </span>
      )}
      {configError && (
        <span className="bz-chip fail" data-testid="config-chip">
          config: {configError}
        </span>
      )}
      <span className="pc-actions">
        <button className="bz-btn sm" type="button" onClick={onValidate} disabled={validating}>
          {validating ? "Validating" : "Validate config"}
        </button>
        <button className="bz-btn ink sm" type="button" onClick={onUnpair}>
          Unpair
        </button>
      </span>
    </div>
  );
}
