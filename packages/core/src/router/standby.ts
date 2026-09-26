import type {
  AgentEntry,
  Config,
  CostTier,
  Effort,
  FailureReason,
  SelectionProvenance,
  SlotRole,
  StandbyEntry,
} from "@punch/shared";

/** Every other eligible agent for the slot, most probable first (plan.md 2.1). */
export function buildStandby(
  probabilities: { id: string; probability: number }[],
  eligible: AgentEntry[],
  chosenId: string,
  excludeIds: string[] = [],
): StandbyEntry[] {
  const skip = new Set([chosenId, ...excludeIds]);
  const weight = new Map(probabilities.map((p) => [p.id, p.probability]));
  return eligible
    .map((a, index) => ({ agentId: a.id, probability: weight.get(a.id) ?? 0, index }))
    .filter((e) => !skip.has(e.agentId))
    .sort((a, b) => b.probability - a.probability || a.index - b.index)
    .map(({ agentId, probability }) => ({ agentId, probability }));
}

/** Providers that failed with an authentication or availability error, with a 5-minute expiry. */
export const PROVIDER_HEALTH_TTL_MS = 5 * 60_000;

export class ProviderHealth {
  private readonly downSince = new Map<string, number>();
  constructor(private readonly ttlMs = PROVIDER_HEALTH_TTL_MS) {}

  markDown(providerId: string, now: number): void {
    this.downSince.set(providerId, now);
  }

  isDown(providerId: string, now: number): boolean {
    const since = this.downSince.get(providerId);
    if (since === undefined) return false;
    if (now - since >= this.ttlMs) {
      this.downSince.delete(providerId);
      return false;
    }
    return true;
  }
}

const TIER_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };
const EFFORT_UP: Record<Effort, Effort> = { low: "medium", medium: "high", high: "high" };

/** One level up from the failed attempt; undefined stays undefined. */
export function bumpEffort(effort: Effort | undefined): Effort | undefined {
  return effort ? EFFORT_UP[effort] : undefined;
}

export interface ReplacementRequest {
  role: SlotRole;
  failedAgentId: string;
  reason: FailureReason;
  config: Config;
  /** Standby list captured when the slot was assigned. */
  standby: StandbyEntry[];
  /** Every agent already tried in this slot, including the failed one. */
  triedAgentIds: string[];
  providerHealth: ProviderHealth;
  now: number;
  /** The failure was an authentication or availability error of the whole provider. */
  providerLevelFailure?: boolean;
  /** Agent currently filling the executor slot, for distinctCritic. */
  executorAgentId?: string;
  failedEffort?: Effort;
  /** Whether the replacement's adapter honours effort; default true. */
  supportsEffort?: (agent: AgentEntry) => boolean;
  /** Fresh Jev routing with the given agents excluded; used only when the standby list is empty. */
  freshRouting?: (
    excludeAgentIds: string[],
  ) => Promise<{ agentId: string; probability?: number } | null>;
}

export interface Replacement {
  agentId: string;
  selection: SelectionProvenance;
  effort?: Effort;
}

interface Candidate {
  agentId: string;
  provenance: SelectionProvenance["provenance"];
  rank?: number;
  probability?: number;
}

/**
 * Replacement selection, plan.md 2.3. Authority: pin (skipped if it is the failed agent),
 * fallback chain, standby list, fresh routing. Returns null when nothing is eligible, which the
 * supervisor turns into `slot.exhausted`.
 */
export async function selectReplacement(req: ReplacementRequest): Promise<Replacement | null> {
  const { config, role } = req;
  const agents = new Map(config.agents.map((a) => [a.id, a]));
  const tried = new Set(req.triedAgentIds);
  tried.add(req.failedAgentId);
  const failedAgent = agents.get(req.failedAgentId);
  const skipped: SelectionProvenance["skipped"] = [];

  const providerDown = (providerId: string): boolean =>
    (req.providerLevelFailure === true && providerId === failedAgent?.providerId) ||
    req.providerHealth.isDown(providerId, req.now);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    if (seen.has(c.agentId)) return;
    seen.add(c.agentId);
    candidates.push(c);
  };
  for (const pin of config.policy.pins.filter((p) => p.role === role)) {
    if (pin.agentId === req.failedAgentId) {
      skipped.push({ agentId: pin.agentId, reason: "pinned agent is the one that failed" });
      continue;
    }
    push({ agentId: pin.agentId, provenance: "pin" });
  }
  for (const chain of config.policy.fallbackChains.filter((c) => c.role === role)) {
    for (const agentId of chain.agentIds) push({ agentId, provenance: "chain" });
  }
  req.standby.forEach((s, i) =>
    push({ agentId: s.agentId, provenance: "standby", rank: i + 1, probability: s.probability }),
  );

  const admissible = (c: Candidate): boolean => {
    const agent = agents.get(c.agentId);
    if (!agent) return skip(c, "not in config");
    if (!agent.roles.includes(role)) return skip(c, `not eligible for ${role}`);
    if (tried.has(c.agentId)) return skip(c, "already tried in this slot");
    if (providerDown(agent.providerId)) return skip(c, `provider ${agent.providerId} is down`);
    if (role === "critic" && config.policy.distinctCritic && c.agentId === req.executorAgentId) {
      return skip(c, "distinctCritic: same agent as the executor");
    }
    return true;
  };
  const skip = (c: Candidate, reason: string): false => {
    skipped.push({ agentId: c.agentId, reason });
    return false;
  };

  let pool = candidates.filter(admissible);
  if (req.reason.kind === "rejected" && failedAgent) {
    const floor = TIER_RANK[failedAgent.costTier];
    const atOrAbove = pool.filter((c) => TIER_RANK[agents.get(c.agentId)!.costTier] >= floor);
    if (atOrAbove.length > 0) {
      for (const c of pool) {
        if (!atOrAbove.includes(c))
          skipped.push({ agentId: c.agentId, reason: "lower cost tier than the rejected agent" });
      }
      pool = atOrAbove;
    }
  }

  let chosen: Candidate | undefined = pool[0];
  if (!chosen && req.standby.length === 0 && req.freshRouting) {
    const exclude = [...tried];
    const fresh = await req.freshRouting(exclude);
    if (fresh) {
      const c: Candidate = {
        agentId: fresh.agentId,
        provenance: "fresh",
        ...(fresh.probability !== undefined ? { probability: fresh.probability } : {}),
      };
      if (admissible(c)) chosen = c;
    }
  }
  if (!chosen) return null;

  const agent = agents.get(chosen.agentId)!;
  const supportsEffort = req.supportsEffort ? req.supportsEffort(agent) : true;
  const effort = supportsEffort ? bumpEffort(req.failedEffort) : undefined;
  return {
    agentId: chosen.agentId,
    selection: {
      provenance: chosen.provenance,
      ...(chosen.rank !== undefined ? { rank: chosen.rank } : {}),
      ...(chosen.probability !== undefined ? { probability: chosen.probability } : {}),
      skipped,
    },
    ...(effort ? { effort } : {}),
  };
}
