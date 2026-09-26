import { z } from "zod";
import { CostTier, Role } from "./common.js";

export const ApiProvider = z.object({
  id: z.string().min(1),
  kind: z.enum(["anthropic", "gemini", "xai", "openai-compatible"]),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1),
});
export const CliProvider = z.object({
  id: z.string().min(1),
  kind: z.enum(["claude-code", "opencode", "antigravity", "grok-cli"]),
  binary: z.string().min(1).optional(),
});
export const Provider = z.union([ApiProvider, CliProvider]);
export type Provider = z.infer<typeof Provider>;

export const Pricing = z.object({
  inputUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative(),
});
export type Pricing = z.infer<typeof Pricing>;

export const AgentEntry = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  costTier: CostTier,
  roles: z.array(Role).min(1),
  strengths: z.string(),
  pricing: Pricing.optional(),
});
export type AgentEntry = z.infer<typeof AgentEntry>;

export const Difficulty = z.enum(["simple", "moderate", "hard"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Policy = z.object({
  pins: z.array(z.object({ role: Role, agentId: z.string() })),
  fallbackChains: z.array(z.object({ role: Role, agentIds: z.array(z.string()) })),
  rules: z.array(z.object({ difficulty: Difficulty, role: Role, agentId: z.string() })),
  preferences: z.string(),
  distinctCritic: z.boolean(),
  autoConfirmBelowConfidence: z.number().min(0).max(1).default(0.6),
  maxReplacementsPerSlot: z.number().int().nonnegative().default(2),
  stallAfterMs: z
    .object({
      api: z.number().int().positive().default(45_000),
      cli: z.number().int().positive().default(120_000),
    })
    .default({ api: 45_000, cli: 120_000 }),
});
export type Policy = z.infer<typeof Policy>;

export const Budgets = z.object({
  maxSteps: z.number().int().positive(),
  maxUsd: z.number().nonnegative(),
  maxWallClockMs: z.number().int().positive(),
});
export type Budgets = z.infer<typeof Budgets>;

export const Config = z.object({
  version: z.literal(1),
  providers: z.array(Provider),
  agents: z.array(AgentEntry),
  policy: Policy,
  budgets: Budgets,
  defaults: z.object({
    mode: z.enum(["auto", "manual"]),
    orchestratorAgentId: z.string().optional(),
  }),
});
export type Config = z.infer<typeof Config>;
