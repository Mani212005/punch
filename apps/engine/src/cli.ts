import { Command } from "commander";
import { getConfigPath, loadConfig, ConfigError } from "./config/index.js";
import { TestAdapterRegistry } from "./config/registry.js";
import { killCommand } from "./kill.js";
import { runCommand } from "./run.js";
import { serveCommand } from "./server/serve.js";

export class NotImplementedError extends Error {
  constructor(command: string) {
    super(`punch ${command}: not implemented yet`);
    this.name = "NotImplementedError";
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildProgram(): Command {
  const program = new Command("punch")
    .description("Punch: multi-agent engine that survives agent failure")
    .showHelpAfterError();

  program
    .command("serve")
    .description("start the engine HTTP API and SSE server")
    .option("-p, --port <port>", "port to listen on", "4141")
    .option("--host <host>", "interface to bind (default localhost)", "127.0.0.1")
    .option("--pairing-token <token>", "control token (generated when absent)")
    .option(
      "--viewer-token <token>",
      "read-only token for run events and trace (generated when absent)",
    )
    .option(
      "--web-origin <origin>",
      "allowed CORS origin, repeatable (e.g. http://localhost:3000)",
      collect,
      [],
    )
    .option("--runs-dir <dir>", "directory holding runs/<runId>", "runs")
    .option("--sessions-dir <dir>", "directory holding orchestrator sessions")
    .option("-c, --config <path>", "path to config file")
    .action(
      async (options: {
        port: string;
        host: string;
        pairingToken?: string;
        viewerToken?: string;
        webOrigin: string[];
        runsDir: string;
        sessionsDir?: string;
        config?: string;
      }) => {
        const running = await serveCommand({
          port: Number(options.port),
          host: options.host,
          runsDir: options.runsDir,
          webOrigins: options.webOrigin,
          ...(options.pairingToken ? { pairingToken: options.pairingToken } : {}),
          ...(options.viewerToken ? { viewerToken: options.viewerToken } : {}),
          ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
          ...(options.config ? { config: options.config } : {}),
        });
        process.once("SIGINT", () => {
          void running.close().then(() => process.exit(0));
        });
      },
    );
  program
    .command("run")
    .description("run the reference task against a GitHub repository")
    .argument("<target>", "GitHub repository URL, or a fixture directory to replay offline")
    .option("-c, --config <path>", "path to config file")
    .option(
      "--chaos <profile>",
      "chaos profile, repeatable (tool:<name>:500|hang|truncate|empty, provider-down:<id>, rate-limit:<id>, stall|timeout|garbage|hallucinate:<role>, kill-after:<role>:<n>)",
      collect,
      [],
    )
    .option("--unattended", "auto-deny irreversible actions instead of asking")
    .option("--budget-usd <usd>", "spend cap in USD for this run", Number)
    .action(async (target: string, options) => {
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      const result = await runCommand(target, {
        config: options.config,
        chaos: options.chaos,
        unattended: options.unattended,
        budgetUsd: options.budgetUsd,
        signal: controller.signal,
      });
      if (result.status === "failed") process.exitCode = 1;
    });
  program
    .command("kill")
    .description("operator kill of the agent in a slot (demo lever)")
    .argument("<runId>")
    .argument("<slot>", "role slot: planner|researcher|executor|critic")
    .option("--runs-dir <dir>", "directory holding runs/<runId>", "runs")
    .option("-m, --message <text>", "reason recorded in the trace")
    .action((runId: string, slot: string, options: { runsDir: string; message?: string }) => {
      try {
        console.log(killCommand(runId, slot, options));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
  program
    .command("approve")
    .description("approve a pending irreversible action")
    .argument("<runId>")
    .argument("<approvalId>")
    .action(async (runId, approvalId, _options) => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const decisionFile = path.join("runs", runId, "approvals", `${approvalId}.decision.json`);
      await fs.writeFile(
        decisionFile,
        JSON.stringify({ approved: true, decidedBy: "cli-approve" }),
        "utf-8",
      );
      console.log(`Approved run ${runId} action ${approvalId}`);
    });
  program
    .command("deny")
    .description("deny a pending irreversible action")
    .argument("<runId>")
    .argument("<approvalId>")
    .action(async (runId, approvalId, _options) => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const decisionFile = path.join("runs", runId, "approvals", `${approvalId}.decision.json`);
      await fs.writeFile(
        decisionFile,
        JSON.stringify({
          approved: false,
          decidedBy: "cli-deny",
          reason: "denied via CLI command",
        }),
        "utf-8",
      );
      console.log(`Denied run ${runId} action ${approvalId}`);
    });

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
