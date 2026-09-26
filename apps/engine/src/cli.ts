import { Command } from "commander";

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
    .action(stub("config validate"));
  config
    .command("test")
    .description("test every configured agent and CLI")
    .action(stub("config test"));

  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
