import type { Config } from "@punch/shared";

export interface AdapterRegistry {
  testAgent(agentId: string, config: Config): Promise<{ ok: boolean; detail: string }>;
  testCliProvider(providerId: string, config: Config): Promise<{ ok: boolean; detail: string }>;
}

export class TestAdapterRegistry implements AdapterRegistry {
  async testAgent(agentId: string, config: Config): Promise<{ ok: boolean; detail: string }> {
    const agent = config.agents.find((a) => a.id === agentId);
    if (!agent) {
      return { ok: false, detail: `Agent not found in config` };
    }
    return { ok: false, detail: `adapter not built yet` };
  }

  async testCliProvider(
    providerId: string,
    config: Config,
  ): Promise<{ ok: boolean; detail: string }> {
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) {
      return { ok: false, detail: `Provider not found in config` };
    }
    return { ok: false, detail: `adapter not built yet` };
  }
}
