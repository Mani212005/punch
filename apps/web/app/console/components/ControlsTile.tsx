"use client";

import React from "react";
import type { Config } from "@punch/shared";

export const CLI_KINDS = new Set(["claude-code", "opencode", "antigravity", "grok-cli"]);

export interface OrchestratorOption {
  id: string;
  label: string;
  disabled: boolean;
}

/** Orchestrator candidates: agents allowed the role; CLI agents cannot call engine tools. */
export function orchestratorOptions(config: Config | null): OrchestratorOption[] {
  if (!config) return [];
  const kinds = new Map(config.providers.map((provider) => [provider.id, provider.kind]));
  const candidates = config.agents.filter((agent) => agent.roles.includes("orchestrator"));
  return (candidates.length > 0 ? candidates : config.agents).map((agent) => {
    const kind = kinds.get(agent.providerId) ?? "unknown";
    const cli = CLI_KINDS.has(kind);
    return {
      id: agent.id,
      label: `${agent.displayName} · ${cli ? "cli" : agent.providerId}${cli ? " · cannot call engine tools" : ""}`,
      disabled: cli,
    };
  });
}

/** Chaos presets built from the configured providers and the demo roles (plan.md 2.6). */
export function chaosOptions(config: Config | null): string[] {
  const providers = [...new Set(config?.providers.map((provider) => provider.id) ?? [])];
  return [
    "none",
    ...providers.slice(0, 2).map((id) => `provider-down:${id}`),
    "stall:researcher",
    "garbage:executor",
    "kill-after:researcher:3",
  ];
}

interface Props {
  config: Config | null;
  orchestratorId: string;
  onOrchestrator: (id: string) => void;
  mode: "auto" | "manual";
  onMode: (mode: "auto" | "manual") => void;
  chaos: string;
  onChaos: (profile: string) => void;
  target: string;
  onTarget: (target: string) => void;
  running: boolean;
  onRun: () => void;
  runError: string | null;
  autoConfirm: number | null;
}

export function ControlsTile(props: Props) {
  const options = orchestratorOptions(props.config);
  return (
    <div className="bz-tile c7" data-testid="controls-tile">
      <div className="bz-label">controls</div>
      <div className="pc-controls">
        <label className="bz-field">
          <span className="bz-label">orchestrator · you talk to</span>
          <select
            className="bz-select"
            aria-label="orchestrator"
            value={props.orchestratorId}
            onChange={(event) => props.onOrchestrator(event.target.value)}
          >
            {options.length === 0 ? (
              <option value="">no agents configured</option>
            ) : options.every((o) => o.disabled) ? (
              <option value="" disabled>
                no eligible agents
              </option>
            ) : null}
            {options.map((option) => (
              <option key={option.id} value={option.id} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="bz-field">
          <span className="bz-label">mode</span>
          <div className="bz-seg" role="group" aria-label="mode">
            {(["auto", "manual"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`bz-btn sm${props.mode === mode ? " primary" : ""}`}
                style={{ flex: 1 }}
                aria-pressed={props.mode === mode}
                onClick={() => props.onMode(mode)}
              >
                {mode === "auto" ? "Auto" : "Manual"}
              </button>
            ))}
          </div>
          <span className="bz-mono bz-muted" style={{ fontSize: 10 }}>
            {props.mode === "auto"
              ? `auto · Jev assigns · confirms below ${props.autoConfirm ?? 0.6}`
              : "manual · you set every role"}
          </span>
        </div>
        <label className="bz-field">
          <span className="bz-label">chaos · demo</span>
          <select
            className="bz-select"
            aria-label="chaos profile"
            value={props.chaos}
            onChange={(event) => props.onChaos(event.target.value)}
          >
            {chaosOptions(props.config).map((profile) => (
              <option key={profile} value={profile}>
                {profile.replace(/:/, ": ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <form
        className="pc-run-row"
        onSubmit={(event) => {
          event.preventDefault();
          props.onRun();
        }}
      >
        <label className="bz-field">
          <span className="bz-label">repo · or fixture:&lt;dir&gt; for an offline replay</span>
          <input
            className="bz-input"
            aria-label="repo"
            value={props.target}
            onChange={(event) => props.onTarget(event.target.value)}
            placeholder="https://github.com/owner/repo"
            spellCheck={false}
          />
        </label>
        <button
          className="bz-btn primary"
          type="submit"
          disabled={props.running || props.target.trim() === ""}
        >
          Run
        </button>
      </form>
      {props.runError && (
        <div className="pc-error" role="alert">
          x {props.runError}
        </div>
      )}
    </div>
  );
}
