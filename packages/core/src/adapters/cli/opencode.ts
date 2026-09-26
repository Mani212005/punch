import type {
  AdapterCapabilities,
  AdapterRunInput,
  AgentAdapter,
  AgentEntry,
  AgentEvent,
  Pricing,
  Provider,
} from "@punch/shared";
import { NO_CHAOS, type AgentChaos } from "../agent.js";
import { defaultParseCliLine, runCliAdapter, testCliBinary } from "./runner.js";

export interface OpenCodeAdapterOptions {
  model: string;
  providerId: string;
  binary?: string;
  pricing?: Pricing;
  chaos?: AgentChaos;
  env?: Record<string, string>;
  workdir?: string;
  keepWorkdir?: boolean;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    effort: true,
  };

  private readonly binary: string;

  constructor(private readonly options: OpenCodeAdapterOptions) {
    this.binary = options.binary ?? "opencode";
  }

  private get chaos(): AgentChaos {
    return this.options.chaos ?? NO_CHAOS;
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    return testCliBinary(this.binary, ["--version"], {
      providerId: this.options.providerId,
      chaos: this.chaos,
      env: this.options.env,
    });
  }

  async *run(input: AdapterRunInput): AsyncGenerator<AgentEvent> {
    yield* runCliAdapter(input, {
      binary: this.binary,
      providerId: this.options.providerId,
      model: this.options.model,
      chaos: this.chaos,
      env: this.options.env,
      workdir: this.options.workdir,
      keepWorkdir: this.options.keepWorkdir,
      buildArgs: (prompt, _promptFilePath, runInput) => {
        const args = ["run", prompt, "--format", "json", "--auto"];
        if (this.options.model) {
          args.push("--model", this.options.model);
        }
        if (runInput.effort) {
          args.push("--variant", runInput.effort);
        }
        return args;
      },
      parseLine: defaultParseCliLine,
    });
  }
}

export function createOpenCodeAdapter(
  agent: AgentEntry,
  provider: Provider,
  options: Partial<OpenCodeAdapterOptions> = {},
): OpenCodeAdapter {
  const binary = provider.kind === "opencode" && provider.binary ? provider.binary : undefined;
  return new OpenCodeAdapter({
    model: agent.model,
    providerId: provider.id,
    ...(binary ? { binary } : {}),
    ...(agent.pricing ? { pricing: agent.pricing } : {}),
    ...options,
  });
}
