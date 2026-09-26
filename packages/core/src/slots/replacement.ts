import type { Provider, SelectionProvenance } from "@punch/shared";

export const CLI_PROVIDER_KINDS: readonly Provider["kind"][] = [
  "claude-code",
  "opencode",
  "antigravity",
  "grok-cli",
];

export const isCliKind = (kind: Provider["kind"] | undefined): boolean =>
  kind !== undefined && CLI_PROVIDER_KINDS.includes(kind);

/**
 * plan.md 2.2/2.3: an authentication, availability or rate-limit failure that survived retries
 * is about the provider, not the agent, so same-provider standbys are skipped.
 */
const PROVIDER_LEVEL =
  /\b(401|403|429|5\d\d)\b|unauthori[sz]ed|authentication|invalid api key|api key|rate.?limit|too many requests|overloaded|service unavailable|bad gateway|no adapter registered|provider .* is down|econnrefused|enotfound/i;

export function isProviderLevelFailure(text: string): boolean {
  return PROVIDER_LEVEL.test(text);
}

/** One line for the takeover banner: who was chosen and how. */
export function describeSelection(agentId: string, selection: SelectionProvenance): string {
  const how =
    selection.provenance === "standby" && selection.rank !== undefined
      ? `standby #${selection.rank}${selection.probability !== undefined ? ` (p=${selection.probability.toFixed(2)})` : ""}`
      : selection.provenance;
  const skipped = selection.skipped.length
    ? `; skipped ${selection.skipped.map((s) => `${s.agentId} (${s.reason})`).join(", ")}`
    : "";
  return `${agentId} via ${how}${skipped}`;
}
