import { Command } from "commander";
import { getConfigPath, loadConfig, ConfigError } from "./config/index.js";
import { TestAdapterRegistry } from "./config/registry.js";

export class NotImplementedError extends Error {
  constructor(command: string) {
    super(`punch ${command}: not implemented yet`);
    this.name = "NotImplementedError";
  }
}

function stub(command: string): () => never {
  return () => {
    throw new NotImplementedError(command);
  };
}

export function buildProgram(): Command {
  const program = new Command("punch")
    .description("Punch: multi-agent engine that survives agent failure")
    .showHelpAfterError();

  program
    .command("serve")
    .description("start the engine HTTP API and SSE server")
    .action(stub("serve"));
  program
    .command("run")
    .description("run the reference task against a GitHub repository")
    .argument("<repoUrl>", "GitHub repository URL")
    .action(stub("run"));
  program
    .command("kill")
    .description("operator kill of the agent in a slot (demo lever)")
    .argument("<runId>")
    .argument("<slot>", "role slot: planner|researcher|executor|critic")
    .action(stub("kill"));
  program
    .command("approve")
    .description("approve a pending irreversible action")
    .argument("<runId>")
    .argument("[approvalId]")
    .action(stub("approve"));
  program
    .command("deny")
    .description("deny a pending irreversible action")
    .argument("<runId>")
    .argument("[approvalId]")
    .action(stub("deny"));

  const config = program.command("config").description("inspect and check ~/.punch/config.json");
  config
    .command("validate")
    .description("validate the config file")
    .option("-c, --config <path>", "path to config file")
    .action(async (options) => {
      try {
        const configPath = getConfigPath(options.config);
        await loadConfig(configPath);
        console.log("Config is valid");
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(err.message);
          err.fieldErrors.forEach((e) => console.error(`  ${e.path}: ${e.message}`));
          process.exitCode = 1;
        } else {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      }
    });

  config
    .command("test")
    .description("test every configured agent and CLI")
    .option("-c, --config <path>", "path to config file")
    .action(async (options) => {
      try {
        const configPath = getConfigPath(options.config);
        const configData = await loadConfig(configPath);
        const registry = new TestAdapterRegistry();

        console.log("Testing CLI providers:");
        const cliProviders = configData.providers.filter((p) => !("apiKeyEnv" in p));
        for (const provider of cliProviders) {
          const res = await registry.testCliProvider(provider.id, configData);
          console.log(`  ${provider.id}: ${res.ok ? "OK" : `FAIL (${res.detail})`}`);
        }

        console.log("Testing agents:");
        for (const agent of configData.agents) {
          const res = await registry.testAgent(agent.id, configData);
          console.log(`  ${agent.id}: ${res.ok ? "OK" : `FAIL (${res.detail})`}`);
        }
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(err.message);
          err.fieldErrors.forEach((e) => console.error(`  ${e.path}: ${e.message}`));
        } else {
          console.error(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
      }
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    if (process.exitCode === undefined) {
      process.exitCode = 1;
    }
    // Only print error if it wasn't already handled by a command action catching it
    // Wait, commander doesn't throw if the action caught it and didn't rethrow.
    // If we reach here, it's either an unhandled exception or commander error (like unknown option)
    if (err instanceof Error && err.name !== "CommanderError" && !(err instanceof ConfigError)) {
      console.error(err.message);
    }
  }
}
