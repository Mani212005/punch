import type {
  AgentEntry,
  Config,
  Difficulty,
  Effort,
  Provenance,
  SlotRole,
  StandbyEntry,
  TraceEvent,
} from "@punch/shared";
import type { Jev, SubtaskRouting, TaskRouting } from "./jev.js";
import { ROUTED_ROLES } from "./jev.js";
import { buildStandby } from "./standby.js";

type Body<K extends TraceEvent["kind"]> = Omit<
  Extract<TraceEvent, { kind: K }>,
  "runId" | "seq" | "ts"
>;
export type RouteEvent = Body<"route.decided"> | Body<"route.skipped">;

/** Score-to-level thresholds live in code (plan.md 0: Jev decides, code acts). */
export const DIFFICULTY_THRESHOLDS = { moderate: 0.67, hard: 1.33 } as const;
export const EFFORT_THRESHOLDS = { medium: 0.34, high: 0.67 } as const;

export function difficultyFromScore(score: number): Difficulty {
  if (score >= DIFFICULTY_THRESHOLDS.hard) return "hard";
  if (score >= DIFFICULTY_THRESHOLDS.moderate) return "moderate";
  return "simple";
}

/** Subtask complexity (0..1) sets the agent's effort. */
export function effortFromComplexity(normalized: number): Effort {
  if (normalized >= EFFORT_THRESHOLDS.high) return "high";
  if (normalized >= EFFORT_THRESHOLDS.medium) return "medium";
  return "low";
}

export interface SlotAssignment {
  role: SlotRole;
  agentId: string;
  provenance: Provenance;
  probabilities: { agentId: string; probability: number }[];
  /** 1 for pin and rule decisions, Jev's confidence otherwise. */
  confidence: number;
  standby: StandbyEntry[];
}

export interface RoutePlan {
  difficulty: Difficulty;
  difficultyScore: number;
  needsExternalData: number;
  isSensitive: number;
  assignments: SlotAssignment[];
  /** Roles no agent could fill. */
  unfilled: SlotRole[];
  /** Auto mode and a Jev-decided role fell below `autoConfirmBelowConfidence`. */
  needsConfirmation: boolean;
  lowConfidenceRoles: SlotRole[];
  warnings: string[];
}

export class JevUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Jev is unavailable and pins/rules cannot decide every role: ${String(cause)}`);
    this.name = "JevUnavailableError";
  }
}

export interface RouteTaskInput {
  config: Config;
  mode: "auto" | "manual";
  task: { brief: string; expectedOutputs: string[]; irreversibleActionsPossible: boolean };
  roles?: SlotRole[];
  exclude?: string[];
  emit?: (event: RouteEvent) => void;
  signal?: AbortSignal;
}

/**
 * Pure policy over a Jev judgment: authority is pin > rule on difficulty > Jev choice, then
 * distinctCritic, then the auto-mode confirmation pause.
 */
export function applyPolicy(
  input: Pick<RouteTaskInput, "config" | "mode" | "roles" | "exclude">,
  routing: TaskRouting | null,
  emit: (event: RouteEvent) => void = () => {},
): RoutePlan {
  const { config } = input;
  const roles = input.roles ?? ROUTED_ROLES;
  const exclude = new Set(input.exclude ?? []);
  const eligibleFor = (role: SlotRole): AgentEntry[] =>
    config.agents.filter((a) => a.roles.includes(role) && !exclude.has(a.id));

  const difficultyScore = routing?.difficulty.score ?? 0;
  const difficulty = routing ? difficultyFromScore(difficultyScore) : undefined;
  const warnings: string[] = [];
  const decided = new Map<SlotRole, SlotAssignment>();
  const unfilled: SlotRole[] = [];

  const decide = (role: SlotRole): void => {
    const eligible = eligibleFor(role);
    const jevVector = routing?.roles[role];
    const probabilities = (jevVector?.probabilities ?? []).map((p) => ({
      agentId: p.id,
      probability: p.probability,
    }));
    const usable = (id: string | undefined): id is string =>
      id !== undefined && eligible.some((a) => a.id === id);

    let agentId: string | undefined;
    let provenance: Provenance = "jev";
    let confidence = jevVector?.confidence ?? 0;

    const pin = config.policy.pins.find((p) => p.role === role && usable(p.agentId));
    if (pin) {
      agentId = pin.agentId;
      provenance = "pin";
      confidence = 1;
    } else if (difficulty) {
      const rule = config.policy.rules.find(
        (r) => r.role === role && r.difficulty === difficulty && usable(r.agentId),
      );
      if (rule) {
        agentId = rule.agentId;
        provenance = "rule";
        confidence = 1;
      }
    }
    if (!agentId) {
      if (jevVector && usable(jevVector.choice)) {
        agentId = jevVector.choice;
      } else if (eligible.length === 1 && eligible[0]) {
        // Nothing to ask: a single eligible agent is the answer.
        agentId = eligible[0].id;
        provenance = "jev";
        confidence = 1;
        emit({
          kind: "route.skipped",
          role,
          reason: `only eligible agent for ${role}: ${agentId}`,
        });
      }
    }
    if (!agentId) {
      unfilled.push(role);
      emit({
        kind: "route.skipped",
        role,
        reason:
          eligible.length === 0
            ? `no eligible agent for ${role}`
            : "Jev unavailable and no pin or rule applies",
      });
      return;
    }
    if (!routing && provenance !== "jev") {
      emit({ kind: "route.skipped", role, reason: `Jev unavailable; decided by ${provenance}` });
    }
    decided.set(role, { role, agentId, provenance, probabilities, confidence, standby: [] });
  };
  for (const role of roles) decide(role);

  // distinctCritic: the critic must not be the executor's agent.
  const executor = decided.get("executor");
  const critic = decided.get("critic");
  if (config.policy.distinctCritic && executor && critic && critic.agentId === executor.agentId) {
    const alternative = buildStandby(
      critic.probabilities.map((p) => ({ id: p.agentId, probability: p.probability })),
      eligibleFor("critic"),
      critic.agentId,
    )[0];
    if (alternative) {
      warnings.push(
        `distinctCritic: critic ${critic.agentId} matched the executor; using ${alternative.agentId}`,
      );
      decided.set("critic", {
        ...critic,
        agentId: alternative.agentId,
        provenance: "standby",
        confidence:
          critic.probabilities.find((p) => p.agentId === alternative.agentId)?.probability ?? 0,
      });
    } else {
      warnings.push(`distinctCritic cannot be honoured: only ${critic.agentId} can fill critic`);
    }
  }

  const assignments: SlotAssignment[] = [];
  for (const role of roles) {
    const a = decided.get(role);
    if (!a) continue;
    a.standby = buildStandby(
      a.probabilities.map((p) => ({ id: p.agentId, probability: p.probability })),
      eligibleFor(role),
      a.agentId,
    );
    if (role === "critic" && config.policy.distinctCritic && executor) {
      a.standby = a.standby.filter((s) => s.agentId !== decided.get("executor")?.agentId);
    }
    assignments.push(a);
    emit({
      kind: "route.decided",
      role,
      agentId: a.agentId,
      provenance: a.provenance,
      probabilities: a.probabilities,
      confidence: a.confidence,
      ...(difficulty ? { difficulty } : {}),
    });
  }

  const lowConfidenceRoles =
    input.mode === "auto"
      ? assignments
          .filter(
            (a) =>
              a.provenance === "jev" && a.confidence < config.policy.autoConfirmBelowConfidence,
          )
          .map((a) => a.role)
      : [];
  return {
    difficulty: difficulty ?? "moderate",
    difficultyScore,
    needsExternalData: routing?.needsExternalData ?? 0,
    isSensitive: routing?.isSensitive ?? 0,
    assignments,
    unfilled,
    needsConfirmation: lowConfidenceRoles.length > 0,
    lowConfidenceRoles,
    warnings,
  };
}

/** One Jev request, then policy. Falls back to pins and rules only if Jev is unavailable. */
export async function routeTask(jev: Jev, input: RouteTaskInput): Promise<RoutePlan> {
  const emit = input.emit ?? (() => {});
  let routing: TaskRouting | null = null;
  let failure: unknown;
  try {
    routing = await jev.routeTask(
      {
        task: input.task,
        agents: input.config.agents,
        preferences: input.config.policy.preferences,
        budget: input.config.budgets,
        ...(input.roles ? { roles: input.roles } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
      },
      input.signal ? { signal: input.signal } : undefined,
    );
  } catch (err) {
    failure = err;
  }
  const plan = applyPolicy(input, routing, emit);
  if (
    !routing &&
    plan.unfilled.length > 0 &&
    plan.assignments.length < (input.roles ?? ROUTED_ROLES).length
  ) {
    // Only an error when some role genuinely needed Jev; roles with no eligible agent stay unfilled.
    const needJev = plan.unfilled.some((r) =>
      input.config.agents.some((a) => a.roles.includes(r) && !(input.exclude ?? []).includes(a.id)),
    );
    if (needJev) throw new JevUnavailableError(failure);
  }
  return plan;
}

export interface SubtaskRoute {
  assignee: SubtaskRouting["assignee"]["choice"];
  confidence: number;
  complexity: number;
  effort: Effort;
}

/** Per-subtask routing: assignee from Jev, effort from complexity thresholds in code. */
export async function routeSubtask(
  jev: Jev,
  input: {
    subtask: Parameters<Jev["routeSubtask"]>[0]["subtask"];
    brief: string;
    signal?: AbortSignal;
  },
): Promise<SubtaskRoute> {
  const routed = await jev.routeSubtask(
    { subtask: input.subtask, brief: input.brief },
    input.signal ? { signal: input.signal } : undefined,
  );
  return {
    assignee: routed.assignee.choice,
    confidence: routed.assignee.confidence,
    complexity: routed.complexity.normalized,
    effort: effortFromComplexity(routed.complexity.normalized),
  };
}
