export function formatTime(ms: number): string {
  if (isNaN(ms) || ms < 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimeWithFraction(ms: number): string {
  if (isNaN(ms) || ms < 0) return "00:00.0";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

const AGENT_METADATA: Record<string, { displayName: string; provider: string; costTier: string }> =
  {
    "opus-5-5": { displayName: "Opus 5.5", provider: "anthropic", costTier: "high" },
    "opus-5": { displayName: "Opus 5", provider: "anthropic", costTier: "high" },
    "gemini-flash": { displayName: "Gemini Flash", provider: "gemini", costTier: "low" },
    grok: { displayName: "Grok", provider: "xai", costTier: "medium" },
    opencode: { displayName: "OpenCode", provider: "cli", costTier: "low" },
    "claude-code": { displayName: "Claude Code", provider: "cli", costTier: "high" },
    antigravity: { displayName: "Antigravity", provider: "cli", costTier: "high" },
  };

export function formatAgentDisplayName(agentId?: string): string {
  if (!agentId) return "unassigned";
  const meta = AGENT_METADATA[agentId];
  if (meta) return meta.displayName;
  // Fallback formatting: capitalize words
  return agentId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function formatAgentFull(agentId?: string): string {
  if (!agentId) return "unassigned";
  const meta = AGENT_METADATA[agentId];
  if (meta) {
    return `${meta.displayName} · ${meta.provider} · ${meta.costTier}`;
  }
  return `${formatAgentDisplayName(agentId)} · custom`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
