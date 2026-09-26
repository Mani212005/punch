import type { AgentAdapter, AgentEntry, Config, Provider } from "@punch/shared";
import { createAnthropicAdapter, type ToolExecutor } from "../adapters/anthropic.js";
import { GeminiAdapter } from "../adapters/gemini.js";
import { NO_CHAOS, type AgentChaos } from "../adapters/agent.js";
import { createClaudeCodeAdapter } from "../adapters/cli/claude-code.js";
import { createOpenCodeAdapter } from "../adapters/cli/opencode.js";
import { createAntigravityAdapter } from "../adapters/cli/antigravity.js";
import { createGrokCliAdapter } from "../adapters/cli/grok-cli.js";

/** What a factory needs to build an adapter for one agent invocation. */
export interface AdapterFactoryContext {
  agent: AgentEntry;
  provider: Provider;
  /** Role- and subtask-scoped tool executor for this invocation (A3 registry, cache, chaos, approval). */
  executeTool: ToolExecutor;
  chaos: AgentChaos;
}

export type AdapterFactory = (ctx: AdapterFactoryContext) => AgentAdapter;

/** The agent's provider has no adapter registered, or the agent or provider is not in config. */
export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterUnavailableError";
  }
}

/**
 * Adapter selection by provider kind. Kinds without a registered factory fail the invocation
 * with `AdapterUnavailableError`, which the run loop treats as a failed slot rather than a crash.
 */
export class AdapterRegistry {
  private readonly factories = new Map<Provider["kind"], AdapterFactory>();

  register(kind: Provider["kind"], factory: AdapterFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  has(kind: Provider["kind"]): boolean {
    return this.factories.has(kind);
  }

  kinds(): Provider["kind"][] {
    return [...this.factories.keys()];
  }

  create(ctx: AdapterFactoryContext): AgentAdapter {
    const factory = this.factories.get(ctx.provider.kind);
    if (!factory) {
      throw new AdapterUnavailableError(
        `no adapter registered for provider kind "${ctx.provider.kind}" (provider ${ctx.provider.id}, agent ${ctx.agent.id})`,
      );
    }
    return factory(ctx);
  }
}

/**
 * Every adapter that exists: the API adapters (anthropic, gemini) and the subscription CLI
 * adapters (claude-code, opencode, antigravity, grok-cli). CLI adapters run their own tool loop
 * and ignore `executeTool`.
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register("claude-code", ({ agent, provider, chaos }) =>
      createClaudeCodeAdapter(agent, provider, { chaos }),
    )
    .register("opencode", ({ agent, provider, chaos }) =>
      createOpenCodeAdapter(agent, provider, { chaos }),
    )
    .register("antigravity", ({ agent, provider, chaos }) =>
      createAntigravityAdapter(agent, provider, { chaos }),
    )
    .register("grok-cli", ({ agent, provider, chaos }) =>
      createGrokCliAdapter(agent, provider, { chaos }),
    )
    .register("anthropic", ({ agent, provider, executeTool, chaos }) =>
      createAnthropicAdapter(agent, provider, { executeTool, chaos }),
    )
    .register("gemini", ({ agent, provider, executeTool, chaos }) => {
      const api = provider.kind === "gemini" ? provider : undefined;
      return new GeminiAdapter({
        model: agent.model,
        providerId: provider.id,
        executeTool,
        chaos,
        ...(api
          ? { apiKeyEnv: api.apiKeyEnv, ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}) }
          : {}),
        ...(agent.pricing ? { pricing: agent.pricing } : {}),
      });
    });
}

/**
 * Health-checks one agent through its real adapter's `test()`. Never throws: a missing agent,
 * provider or adapter comes back as `{ ok: false, detail }`.
 */
export async function testAgentHealth(
  agentId: string,
  config: Config,
  adapters: AdapterRegistry = createDefaultAdapterRegistry(),
): Promise<{ ok: boolean; detail: string }> {
  const agent = config.agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, detail: "Agent not found in config" };
  const provider = config.providers.find((p) => p.id === agent.providerId);
  if (!provider) return { ok: false, detail: `Provider ${agent.providerId} not found in config` };
  try {
    const adapter = adapters.create({
      agent,
      provider,
      executeTool: async () => {
        throw new Error("tools are not available during a health check");
      },
      chaos: NO_CHAOS,
    });
    return await adapter.test();
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Health-checks one provider by testing the first agent configured on it. */
export async function testProviderHealth(
  providerId: string,
  config: Config,
  adapters: AdapterRegistry = createDefaultAdapterRegistry(),
): Promise<{ ok: boolean; detail: string }> {
  if (!config.providers.some((p) => p.id === providerId)) {
    return { ok: false, detail: "Provider not found in config" };
  }
  const agent = config.agents.find((a) => a.providerId === providerId);
  if (!agent) return { ok: false, detail: "No agent is configured on this provider" };
  return testAgentHealth(agent.id, config, adapters);
}
