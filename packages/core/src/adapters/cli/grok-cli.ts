import type {
  AdapterCapabilities,
  AdapterRunInput,
  AgentAdapter,
  AgentEntry,
  AgentEvent,
  Pricing,
  Provider,
} from "@punch/shared";
import type { AgentChaos } from "../agent.js";

export interface GrokCliAdapterOptions {
  model: string;
  providerId: string;
  binary?: string;
  pricing?: Pricing;
  chaos?: AgentChaos;
}

export class GrokCliAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    effort: false,
  };

  constructor(private readonly options?: Partial<GrokCliAdapterOptions>) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: "grok-cli: no subscription" };
  }

  async *run(_input: AdapterRunInput): AsyncGenerator<AgentEvent> {
    yield { type: "heartbeat" };
    yield { type: "done", status: "error", error: "grok-cli: no subscription" };
  }
}

export function createGrokCliAdapter(
  agent: AgentEntry,
  provider: Provider,
  options: Partial<GrokCliAdapterOptions> = {},
): GrokCliAdapter {
  return new GrokCliAdapter({
    model: agent.model,
    providerId: provider.id,
    ...(agent.pricing ? { pricing: agent.pricing } : {}),
    ...options,
  });
}
