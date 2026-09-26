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

export interface ClaudeCodeAdapterOptions {
  model: string;
  providerId: string;
  binary?: string;
  permissionMode?: string;
  pricing?: Pricing;
  chaos?: AgentChaos;
  env?: Record<string, string>;
  workdir?: string;
  keepWorkdir?: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    effort: true,
  };

  private readonly binary: string;

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    this.binary = options.binary ?? "claude";
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
        const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
        if (this.options.model) {
          args.push("--model", this.options.model);
        }
        if (runInput.effort) {
          args.push("--effort", runInput.effort);
        }
        if (this.options.permissionMode) {
          args.push("--permission-mode", this.options.permissionMode);
        } else {
          args.push("--dangerously-skip-permissions");
        }
        return args;
      },
      parseLine: defaultParseCliLine,
    });
  }
}

export function createClaudeCodeAdapter(
  agent: AgentEntry,
  provider: Provider,
  options: Partial<ClaudeCodeAdapterOptions> = {},
): ClaudeCodeAdapter {
  const binary = provider.kind === "claude-code" && provider.binary ? provider.binary : undefined;
  return new ClaudeCodeAdapter({
    model: agent.model,
    providerId: provider.id,
    ...(binary ? { binary } : {}),
    ...(agent.pricing ? { pricing: agent.pricing } : {}),
    ...options,
  });
}
