import { z } from "zod";
import type { AgentEntry, Config, Provider, SlotRole, ToolSpec } from "@punch/shared";
import type { Jev } from "../router/jev.js";
import { routeTask, type RoutePlan } from "../router/policy.js";

/** Manual-mode refusal: `start_run` asked for something the user did not choose. */
export class ManualRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualRefusalError";
  }
}

/** The orchestrator tried to decide an approval instead of relaying the human's decision. */
export class OrchestratorApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorApprovalError";
  }
}

/** The chosen orchestrator agent cannot call tools (CLI agents cannot orchestrate). */
export class NonToolCallingOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonToolCallingOrchestratorError";
  }
}

/** A manual role selection made by the user (console or `POST /runs/:id/assignments`). */
export interface ManualSelection {
  role: SlotRole;
  agentId: string;
}

const ManualSelectionSchema = z.object({
  role: z.enum([
    "planner",
    "inventory",
    "researcher",
    "reachability",
    "impact",
    "investigator",
    "critic",
    "executor",
  ]),
  agentId: z.string().min(1),
});

export const ConsultRouterInput = z.object({
  brief: z.string().min(1),
  repoUrl: z.string().min(1).optional(),
  roles: z.array(ManualSelectionSchema.shape.role).optional(),
});
export type ConsultRouterInput = z.infer<typeof ConsultRouterInput>;

export const StartRunInput = z.object({
  repoUrl: z.string().min(1),
  brief: z.string().min(1).optional(),
  budgetUsd: z.number().nonnegative().optional(),
  assignments: z.array(ManualSelectionSchema).optional(),
});
export type StartRunInput = z.infer<typeof StartRunInput>;

export const GetRunStatusInput = z.object({ runId: z.string().min(1) });
export type GetRunStatusInput = z.infer<typeof GetRunStatusInput>;

export const AnswerApprovalInput = z.object({
  runId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  /** Who made the decision. Must name the human (e.g. `human:console`); anything else refuses. */
  decidedBy: z.string().min(1),
  reason: z.string().optional(),
});
export type AnswerApprovalInput = z.infer<typeof AnswerApprovalInput>;

export interface RunStartReceipt {
  runId: string;
  status: string;
}

export interface RunStatusReport {
  runId: string;
  status: string;
  pendingApprovals: { approvalId: string; tool: string; payload: unknown }[];
}

/**
 * What the four engine tools need from the host (the session in core tests, the
 * engine HTTP layer in production). The run itself never depends on the
 * orchestrator: `startRun` launches and returns a receipt while the run
 * continues on its own (plan.md 2.7).
 */
export interface OrchestratorToolDeps {
  config: Config;
  mode: "auto" | "manual";
  jev: Jev;
  /** The user's manual selections, when any have been recorded. */
  getManualSelections: () => ManualSelection[];
  startRun: (input: {
    repoUrl: string;
    brief?: string;
    budgetUsd?: number;
    assignments?: ManualSelection[];
  }) => Promise<RunStartReceipt>;
  getRunStatus: (runId: string) => Promise<RunStatusReport>;
  answerApproval: (input: {
    runId: string;
    approvalId: string;
    approved: boolean;
    decidedBy: string;
    reason?: string;
  }) => Promise<{ ok: true }>;
}

export const ORCHESTRATOR_TOOL_NAMES = [
  "consult_router",
  "start_run",
  "get_run_status",
  "answer_approval",
] as const;
export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

function jsonSchema(obj: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, ...obj };
}

export const ORCHESTRATOR_TOOL_SPECS: ToolSpec[] = [
  {
    name: "consult_router",
    description:
      "Ask Jev + policy who should fill each role. Returns assignments, standby lists, " +
      "probabilities, confidence, difficulty, and provenance. Read-only: never starts a run.",
    inputSchema: jsonSchema({
      properties: {
        brief: { type: "string", description: "The investigation task brief." },
        repoUrl: { type: "string", description: "Repository under investigation, if known." },
        roles: {
          type: "array",
          items: { type: "string" },
          description: "Subset of slot roles to route; defaults to the routed roles.",
        },
      },
      required: ["brief"],
    }),
  },
  {
    name: "start_run",
    description:
      "Launch the investigation run. In manual mode refuses assignments that differ from " +
      "the user's manual selection. Returns immediately; the run continues on its own.",
    inputSchema: jsonSchema({
      properties: {
        repoUrl: { type: "string" },
        brief: { type: "string" },
        budgetUsd: { type: "number" },
        assignments: {
          type: "array",
          items: {
            type: "object",
            properties: { role: { type: "string" }, agentId: { type: "string" } },
            required: ["role", "agentId"],
          },
        },
      },
      required: ["repoUrl"],
    }),
    irreversible: true,
  },
  {
    name: "get_run_status",
    description: "Read the run's status and pending approvals. Read-only.",
    inputSchema: jsonSchema({
      properties: { runId: { type: "string" } },
      required: ["runId"],
    }),
  },
  {
    name: "answer_approval",
    description:
      "Relay the human's approval decision to a waiting run. Acknowledge only: the " +
      "`decidedBy` field must name the human (e.g. `human:console`). The orchestrator " +
      "never decides approvals itself.",
    inputSchema: jsonSchema({
      properties: {
        runId: { type: "string" },
        approvalId: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
        decidedBy: {
          type: "string",
          description: "Who decided. Must start with `human:` (the orchestrator never decides).",
        },
        reason: { type: "string" },
      },
      required: ["runId", "approvalId", "decision", "decidedBy"],
    }),
    irreversible: true,
  },
];

/** In manual mode, `start_run` assignments must equal the user's manual selection. */
export function assertManualAssignments(
  mode: "auto" | "manual",
  manual: ManualSelection[],
  requested: ManualSelection[] | undefined,
): void {
  if (mode !== "manual") return;
  if (manual.length === 0) return;
  const same =
    (requested ?? []).length === manual.length &&
    manual.every((m) => requested?.some((r) => r.role === m.role && r.agentId === m.agentId));
  if (!same) {
    const want = manual.map((m) => `${m.role}=${m.agentId}`).join(", ");
    const got = (requested ?? []).map((r) => `${r.role}=${r.agentId}`).join(", ") || "(none)";
    throw new ManualRefusalError(
      `manual mode: start_run assignments [${got}] differ from the user's manual selection [${want}]; refusing`,
    );
  }
}

/** `consult_router`: assignments, standby lists, probabilities, confidence, difficulty, provenance. */
export async function consultRouter(deps: OrchestratorToolDeps, raw: unknown): Promise<RoutePlan> {
  const input = ConsultRouterInput.parse(raw);
  return routeTask(deps.jev, {
    config: deps.config,
    mode: deps.mode,
    task: {
      brief: input.brief,
      expectedOutputs: ["security investigation report"],
      irreversibleActionsPossible: true,
    },
    ...(input.roles ? { roles: input.roles } : {}),
  });
}

/** `start_run` with manual-mode enforcement. */
export async function startRun(deps: OrchestratorToolDeps, raw: unknown): Promise<RunStartReceipt> {
  const input = StartRunInput.parse(raw);
  assertManualAssignments(deps.mode, deps.getManualSelections(), input.assignments);
  return deps.startRun({
    repoUrl: input.repoUrl,
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.assignments !== undefined ? { assignments: input.assignments } : {}),
  });
}

/** `get_run_status`: read-only. */
export async function getRunStatus(
  deps: OrchestratorToolDeps,
  raw: unknown,
): Promise<RunStatusReport> {
  const input = GetRunStatusInput.parse(raw);
  return deps.getRunStatus(input.runId);
}

/**
 * `answer_approval`: acknowledge only. The orchestrator relays the human's
 * decision and never decides: `decidedBy` must start with `human:`.
 */
export async function answerApproval(
  deps: OrchestratorToolDeps,
  raw: unknown,
): Promise<{ ok: true }> {
  const input = AnswerApprovalInput.parse(raw);
  if (!input.decidedBy.startsWith("human:")) {
    throw new OrchestratorApprovalError(
      "answer_approval relays the human's decision only (`decidedBy` must start with `human:`); the orchestrator never decides approvals",
    );
  }
  return deps.answerApproval({
    runId: input.runId,
    approvalId: input.approvalId,
    approved: input.decision === "approve",
    decidedBy: input.decidedBy,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** Dispatch one engine-tool call by name; unknown tools throw. */
export async function executeOrchestratorTool(
  deps: OrchestratorToolDeps,
  name: string,
  input: unknown,
): Promise<unknown> {
  switch (name) {
    case "consult_router":
      return consultRouter(deps, input);
    case "start_run":
      return startRun(deps, input);
    case "get_run_status":
      return getRunStatus(deps, input);
    case "answer_approval":
      return answerApproval(deps, input);
    default:
      throw new Error(`unknown orchestrator tool "${name}"`);
  }
}

/** Resolve the user-chosen orchestrator agent; only tool-calling adapters qualify. */
export function resolveOrchestratorAgent(
  config: Config,
  orchestratorAgentId: string | undefined,
): { agent: AgentEntry; provider: Provider } {
  const id = orchestratorAgentId ?? config.defaults.orchestratorAgentId;
  const agent = config.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`unknown orchestrator agent "${id ?? "unassigned"}"`);
  if (!agent.roles.includes("orchestrator")) {
    throw new Error(`agent "${agent.id}" is not eligible for the orchestrator role`);
  }
  const provider = config.providers.find((p) => p.id === agent.providerId);
  if (!provider) throw new Error(`unknown provider "${agent.providerId}" for agent "${agent.id}"`);
  if (provider.kind !== "anthropic" && provider.kind !== "gemini") {
    throw new NonToolCallingOrchestratorError(
      `orchestrator agent "${agent.id}" uses provider kind "${provider.kind}", which cannot call tools, and the orchestrator chat needs tool calling. Add an Anthropic or Gemini provider (set ANTHROPIC_API_KEY or GEMINI_API_KEY) and point defaults.orchestratorAgentId at it. \`punch run\` still works with CLI agents only`,
    );
  }
  return { agent, provider };
}
