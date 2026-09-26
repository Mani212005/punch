import type { AgentAdapter, AgentEntry, Provider } from "@punch/shared";
import { createAnthropicAdapter, type ToolExecutor } from "../adapters/anthropic.js";
import { GeminiAdapter } from "../adapters/gemini.js";
import type { AgentChaos } from "../adapters/agent.js";

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

/** Every adapter that exists on main. The CLI adapters register here as they land. */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry()
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
