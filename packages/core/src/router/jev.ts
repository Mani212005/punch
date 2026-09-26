import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { AgentEntry, ErrorClass, SlotRole, Subtask } from "@punch/shared";
import { ErrorClass as ErrorClassSchema } from "@punch/shared";

/**
 * Jev decides, code acts (plan.md 3.5). This module only turns application state into Jev
 * questions and Jev answers into typed, raw judgments. Thresholds and authority live in
 * policy.ts and config.
 */

// ---------------------------------------------------------------------------
// Transport: the seam between Punch and the wire. Real = TypeSafe SDK, tests = recorded.
// ---------------------------------------------------------------------------

const Probabilities = z.record(z.string(), z.number());

/** Response shape of `POST /v1/systemone`, as documented and confirmed by the live test. */
export const JevAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: Probabilities,
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.unknown()),
    probabilities: Probabilities,
    confidence: z.number().min(0).max(1),
  }),
]);
export type JevAnswer = z.infer<typeof JevAnswer>;

export const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
export type JevResponse = z.infer<typeof JevResponse>;

export interface JevRequest {
  state: unknown;
  questions: Questions;
}

export interface JevTransport {
  evaluate(request: JevRequest, options?: { signal?: AbortSignal }): Promise<JevResponse>;
}

/** Real transport over `@typesafe-ai/sdk`. Reads `TYPESAFE_API_KEY` unless given a key. */
export function createTypeSafeTransport(
  options: { apiKey?: string; client?: TypeSafeClient } = {},
): JevTransport {
  const client =
    options.client ?? new TypeSafeClient(options.apiKey ? { apiKey: options.apiKey } : {});
  return {
    async evaluate(request, opts) {
      const raw = await client.systemOne(
        // The SDK types state as JSON values; our state objects are plain JSON.
        { state: request.state as never, questions: request.questions, model: "jev-latest" },
        opts?.signal ? { signal: opts.signal } : undefined,
      );
      return JevResponse.parse(raw);
    },
  };
}

/** One recorded exchange: the question ids it answers, and either a response or an error. */
export interface RecordedExchange {
  questionIds?: string[];
  response?: unknown;
  error?: { message: string; status?: number };
}

/** Replays recorded exchanges, matching on the exact set of question ids. No network. */
export function createRecordedTransport(
  exchanges: (RecordedExchange | JevResponse | Record<string, unknown>)[],
): JevTransport & {
  requests: JevRequest[];
} {
  const requests: JevRequest[] = [];
  const normalized: RecordedExchange[] = exchanges.map((e) => {
    if ("questionIds" in e || "error" in e) {
      const rec = e as RecordedExchange;
      const questionIds =
        rec.questionIds ??
        (rec.response && typeof rec.response === "object" && "answers" in rec.response
          ? Object.keys((rec.response as { answers: Record<string, unknown> }).answers)
          : []);
      return { ...rec, questionIds };
    }
    const resp = e as { answers?: Record<string, unknown> };
    return {
      questionIds: resp.answers ? Object.keys(resp.answers) : [],
      response: e,
    };
  });
  return {
    requests,
    evaluate(request) {
      requests.push(request);
      const ids = Object.keys(request.questions).sort().join("|");
      const hit = normalized.find((e) => [...(e.questionIds ?? [])].sort().join("|") === ids);
      if (!hit) return Promise.reject(new Error(`no recorded Jev exchange for [${ids}]`));
      if (hit.error) {
        return Promise.reject(
          Object.assign(new Error(hit.error.message), { status: hit.error.status }),
        );
      }
      return Promise.resolve(JevResponse.parse(hit.response));
    },
  };
}

// ---------------------------------------------------------------------------
// Typed judgments
// ---------------------------------------------------------------------------

export interface ChoiceJudgment {
  choice: string;
  /** Probability per option, descending. */
  probabilities: { id: string; probability: number }[];
  confidence: number;
}

export interface ScoreJudgment {
  /** Raw Jev score, 0-based position on the rubric levels. */
  score: number;
  levels: number;
  /** score / (levels - 1), in 0..1. */
  normalized: number;
  probabilities: number[];
  confidence: number;
}

export interface TaskRoutingInput {
  task: { brief: string; expectedOutputs: string[]; irreversibleActionsPossible: boolean };
  agents: AgentEntry[];
  preferences: string;
  budget: { maxSteps: number; maxUsd: number; maxWallClockMs: number };
  /** Roles to choose an agent for; each needs at least two eligible agents to be asked. */
  roles?: SlotRole[];
  /** Agents never offered (fresh routing after a failure). */
  exclude?: string[];
}

export interface TaskRouting {
  difficulty: ScoreJudgment;
  /** Absent for roles with fewer than two eligible agents (nothing to ask). */
  roles: Partial<Record<SlotRole, ChoiceJudgment>>;
  needsExternalData: number;
  isSensitive: number;
  /** Agents offered per role, in config order. */
  eligible: Record<SlotRole, string[]>;
  model: string;
}

export type SubtaskAssignee =
  | "inventory"
  | "researcher"
  | "reachability"
  | "impact"
  | "investigator"
  | "executor"
  | "none_needed"
  | "human";

export interface SubtaskRouting {
  assignee: ChoiceJudgment & { choice: SubtaskAssignee };
  complexity: ScoreJudgment;
}

export interface ErrorClassification {
  errorClass: ErrorClass;
  probabilities: { id: ErrorClass; probability: number }[];
  confidence: number;
}

export interface ClaimCheck {
  id: string;
  claim: string;
  evidence: string;
}

export interface Jev {
  routeTask(input: TaskRoutingInput, options?: { signal?: AbortSignal }): Promise<TaskRouting>;
  routeSubtask(
    input: { subtask: Pick<Subtask, "title" | "description" | "roleHint">; brief: string },
    options?: { signal?: AbortSignal },
  ): Promise<SubtaskRouting>;
  classifyError(
    input: { text: string; status?: number; tool?: string },
    options?: { signal?: AbortSignal },
  ): Promise<ErrorClassification>;
  /** Probability each claim is supported by its cited evidence, keyed by claim id. */
  precheckClaims(
    claims: ClaimCheck[],
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Question construction
// ---------------------------------------------------------------------------

export const ROUTED_ROLES: readonly SlotRole[] = [
  "planner",
  "inventory",
  "researcher",
  "reachability",
  "impact",
  "investigator",
  "executor",
  "critic",
];

const ROLE_DESCRIPTIONS: Record<SlotRole, string> = {
  planner: "Decomposes the brief into a subtask DAG with role hints.",
  researcher:
    "Inventories dependencies, queries vulnerability databases, reads release notes; needs reliable tool calling.",
  executor:
    "Writes the remediation report and, with approval, files the issue; needs precise writing.",
  inventory: "Lists the repository's dependencies from manifests and lockfiles.",
  reachability:
    "Decides whether affected code is reachable in this repository from imports, call sites and entrypoints.",
  impact: "Assesses what an upgrade could break from release notes, usage and tests.",
  investigator: "Synthesizes findings into evidence-backed conclusions and recommendations.",
  critic: "Checks every claim against evidence and rejects unsupported or fabricated ones.",
};

const DIFFICULTY_LEVELS = [
  "simple: a small, well-specified task; one clear source of data, few dependencies, little judgment.",
  "moderate: several sources or steps, some judgment about trade-offs, a typical repository.",
  "hard: many interdependent steps, ambiguous or conflicting evidence, high stakes for errors.",
] as const;

const COMPLEXITY_LEVELS = [
  "low: a mechanical lookup or transformation with an obvious answer.",
  "medium: needs some reasoning over several inputs.",
  "high: needs deep multi-step reasoning, weighing conflicting evidence, or careful synthesis.",
] as const;

const ASSIGNEES: Record<SubtaskAssignee, string> = {
  inventory: "Needs the repository's dependency list from manifests and lockfiles.",
  researcher: "Needs data gathered from external tools or APIs (GitHub, OSV, npm registry).",
  reachability:
    "Needs reachability analysis: imports, call sites of affected symbols, entrypoints and routes.",
  impact: "Needs upgrade-impact analysis: release notes, changelogs, usage and test coverage.",
  investigator: "Needs synthesis of evidence streams into findings with recommendations.",
  executor: "Needs writing or an action built from data already gathered, such as the report.",
  none_needed: "Already satisfied by existing inputs; no agent work required.",
  human: "Requires a person's judgment or authority that no agent should exercise.",
};

const ERROR_CLASSES: Record<ErrorClass, string> = {
  transient:
    "Temporary condition that a retry of the same call is likely to fix: timeout, rate limit, 5xx, network reset.",
  permanent:
    "Retrying will not help: authentication failure, forbidden, invalid request, unsupported operation.",
  malformed: "The call succeeded but the response has the wrong shape or is not parseable.",
  not_found: "The requested resource does not exist: 404, missing file, unknown package.",
};

const agentQuestionId = (role: SlotRole) => `role_${role}`;

function eligibleFor(input: TaskRoutingInput, role: SlotRole): AgentEntry[] {
  const excluded = new Set(input.exclude ?? []);
  return input.agents.filter((a) => a.roles.includes(role) && !excluded.has(a.id));
}

function toChoice(answer: JevAnswer, id: string): ChoiceJudgment {
  if (answer.type !== "choice")
    throw new Error(`Jev answer ${id}: expected choice, got ${answer.type}`);
  return {
    choice: answer.choice,
    probabilities: Object.entries(answer.probabilities)
      .map(([key, probability]) => ({ id: key, probability }))
      .sort((a, b) => b.probability - a.probability),
    confidence: answer.confidence,
  };
}

function toScore(answer: JevAnswer, id: string, levels: number): ScoreJudgment {
  if (answer.type !== "score")
    throw new Error(`Jev answer ${id}: expected score, got ${answer.type}`);
  const probabilities = Array.from(
    { length: levels },
    (_, i) => answer.probabilities[String(i)] ?? 0,
  );
  return {
    score: answer.score,
    levels,
    normalized: Math.min(1, Math.max(0, answer.score / (levels - 1))),
    probabilities,
    confidence: answer.confidence,
  };
}

function toNoul(answer: JevAnswer, id: string): number {
  if (answer.type !== "noul")
    throw new Error(`Jev answer ${id}: expected noul, got ${answer.type}`);
  return answer.noul;
}

function answerOf(response: JevResponse, id: string): JevAnswer {
  const answer = response.answers[id];
  if (!answer) throw new Error(`Jev response is missing answer "${id}"`);
  return answer;
}

export function createJev(transport: JevTransport): Jev {
  return {
    async routeTask(input, options) {
      const roles = input.roles ?? ROUTED_ROLES;
      const eligible = Object.fromEntries(
        ROUTED_ROLES.map((r) => [r, eligibleFor(input, r).map((a) => a.id)]),
      ) as Record<SlotRole, string[]>;

      const questions: Questions = {
        difficulty: score(
          "How demanding is this task overall, considering `task`, its expected outputs and the stakes?",
          DIFFICULTY_LEVELS,
        ),
        needs_external_data: noul(
          "Does completing `task` need data that is not contained in the request itself?",
        ),
        is_sensitive: noul(
          "Would completing `task` change anything outside this program, such as filing an issue or modifying a repository?",
        ),
      };
      const asked: SlotRole[] = [];
      for (const role of roles) {
        const candidates = eligibleFor(input, role);
        if (candidates.length < 2) continue;
        asked.push(role);
        questions[agentQuestionId(role)] = choice(
          `Which agent should fill the ${role} role? Weigh each agent's stated strengths, its cost tier, and \`preferences\`. Role: ${ROLE_DESCRIPTIONS[role]}`,
          Object.fromEntries(
            candidates.map((a) => [
              a.id,
              `${a.displayName} (${a.providerId}, cost tier ${a.costTier}): ${a.strengths}`,
            ]),
          ),
        );
      }

      const state = {
        task: input.task,
        agents: input.agents
          .filter((a) => !(input.exclude ?? []).includes(a.id))
          .map((a) => ({
            id: a.id,
            displayName: a.displayName,
            provider: a.providerId,
            costTier: a.costTier,
            roles: a.roles,
            strengths: a.strengths,
          })),
        preferences: input.preferences,
        budget: input.budget,
      };

      const response = await transport.evaluate({ state, questions }, options);
      const routed: Partial<Record<SlotRole, ChoiceJudgment>> = {};
      for (const role of asked)
        routed[role] = toChoice(answerOf(response, agentQuestionId(role)), agentQuestionId(role));
      return {
        difficulty: toScore(
          answerOf(response, "difficulty"),
          "difficulty",
          DIFFICULTY_LEVELS.length,
        ),
        roles: routed,
        needsExternalData: toNoul(answerOf(response, "needs_external_data"), "needs_external_data"),
        isSensitive: toNoul(answerOf(response, "is_sensitive"), "is_sensitive"),
        eligible,
        model: response.model,
      };
    },

    async routeSubtask({ subtask, brief }, options) {
      const response = await transport.evaluate(
        {
          state: {
            brief,
            subtask: {
              title: subtask.title,
              description: subtask.description,
              plannerRoleHint: subtask.roleHint,
            },
          },
          questions: {
            assignee: choice("Who should carry out `subtask`?", ASSIGNEES),
            complexity: score("How much reasoning does `subtask` demand?", COMPLEXITY_LEVELS),
          },
        },
        options,
      );
      const assignee = toChoice(answerOf(response, "assignee"), "assignee");
      if (!(assignee.choice in ASSIGNEES))
        throw new Error(`Jev returned unknown assignee "${assignee.choice}"`);
      return {
        assignee: assignee as SubtaskRouting["assignee"],
        complexity: toScore(
          answerOf(response, "complexity"),
          "complexity",
          COMPLEXITY_LEVELS.length,
        ),
      };
    },

    async classifyError({ text, status, tool }, options) {
      const response = await transport.evaluate(
        {
          state: { error: text, httpStatus: status ?? null, tool: tool ?? null },
          questions: {
            error_class: choice(
              "Which class of failure is `error`, and how should the caller react?",
              ERROR_CLASSES,
            ),
          },
        },
        options,
      );
      const judged = toChoice(answerOf(response, "error_class"), "error_class");
      return {
        errorClass: ErrorClassSchema.parse(judged.choice),
        probabilities: judged.probabilities.map((p) => ({
          id: ErrorClassSchema.parse(p.id),
          probability: p.probability,
        })),
        confidence: judged.confidence,
      };
    },

    async precheckClaims(claims, options) {
      if (claims.length === 0) return {};
      const questions: Questions = {};
      claims.forEach((c, i) => {
        questions[`claim_${i}`] = noul({
          claim: c.claim,
          evidence: c.evidence,
          question: "Is `claim` supported by the cited `evidence`?",
        });
      });
      const response = await transport.evaluate(
        { state: { claims: claims.map((c) => c.id) }, questions },
        options,
      );
      return Object.fromEntries(
        claims.map((c, i) => [c.id, toNoul(answerOf(response, `claim_${i}`), `claim_${i}`)]),
      );
    },
  };
}
