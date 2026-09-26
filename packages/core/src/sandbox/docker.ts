import { randomBytes } from "node:crypto";
import type { ProcessRunner, ProcessResult } from "./runner.js";

/** Pinned Node image for every validation. Override per run, never per repo. */
export const DEFAULT_SANDBOX_IMAGE =
  "node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da";

export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
  installTimeoutMs: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  /** Wall-clock cap for the whole validation (both phases). */
  totalTimeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryMb: 2048,
  pids: 512,
  installTimeoutMs: 300_000,
  buildTimeoutMs: 300_000,
  testTimeoutMs: 600_000,
  totalTimeoutMs: 1_500_000,
};

export interface StepExecRequest {
  /** Shell command line to run in the workdir. */
  shell: string;
  workdir: string;
  /** Network is granted only when this is true (the install step). */
  network: boolean;
  timeoutMs: number;
  env: Record<string, string>;
  signal?: AbortSignal;
}

/** Runs one step in some isolation. Docker and host are the two implementations. */
export interface StepExecutor {
  readonly isolation: "docker" | "host";
  exec(request: StepExecRequest): Promise<ProcessResult>;
}

/** Environment the docker client itself needs on the host; never contains repo or API secrets. */
export function dockerClientEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function isDockerAvailable(
  runner: ProcessRunner,
  env = dockerClientEnv(),
): Promise<boolean> {
  const result = await runner({
    command: "docker",
    args: ["info", "--format", "{{.ServerVersion}}"],
    env,
    timeoutMs: 15_000,
  });
  return result.exitCode === 0 && result.output.trim().length > 0;
}

export interface DockerRunArgsInput {
  name: string;
  image: string;
  workdir: string;
  shell: string;
  network: boolean;
  limits: SandboxLimits;
  env: Record<string, string>;
  user?: string;
}

/** The exact `docker run` argv for one step. Pure, so the isolation flags are unit-testable. */
export function buildDockerRunArgs(input: DockerRunArgsInput): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    input.name,
    "--network",
    input.network ? "bridge" : "none",
    "--cpus",
    String(input.limits.cpus),
    "--memory",
    `${input.limits.memoryMb}m`,
    "--memory-swap",
    `${input.limits.memoryMb}m`,
    "--pids-limit",
    String(input.limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,exec,size=1g",
    "-v",
    `${input.workdir}:/work`,
    "-w",
    "/work",
  ];
  if (input.user) args.push("--user", input.user);
  for (const [key, value] of Object.entries(input.env)) args.push("-e", `${key}=${value}`);
  args.push(input.image, "sh", "-c", input.shell);
  return args;
}

export interface DockerExecutorOptions {
  runner: ProcessRunner;
  image?: string;
  limits?: SandboxLimits;
  /** Container user, `uid:gid`. Defaults to the current user so files in the mount stay removable. */
  user?: string;
  clientEnv?: Record<string, string>;
  nameSuffix?: () => string;
}

/**
 * One disposable container per step, all mounting the same throwaway copy. Splitting per step
 * is what lets the network be on for install and off for build and test without reconfiguring a
 * live container. The container is force-removed in `finally`, so a crash, timeout or abort
 * never leaves one behind (`--rm` covers the normal exit).
 */
export class DockerExecutor implements StepExecutor {
  readonly isolation = "docker" as const;
  private readonly runner: ProcessRunner;
  private readonly image: string;
  private readonly limits: SandboxLimits;
  private readonly user: string | undefined;
  private readonly clientEnv: Record<string, string>;
  private readonly nameSuffix: () => string;

  constructor(options: DockerExecutorOptions) {
    this.runner = options.runner;
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.limits = options.limits ?? DEFAULT_SANDBOX_LIMITS;
    this.clientEnv = options.clientEnv ?? dockerClientEnv();
    this.nameSuffix = options.nameSuffix ?? (() => randomBytes(6).toString("hex"));
    this.user =
      options.user ??
      (typeof process.getuid === "function" && typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : undefined);
  }

  async exec(request: StepExecRequest): Promise<ProcessResult> {
    const name = `punch-sbx-${this.nameSuffix()}`;
    const args = buildDockerRunArgs({
      name,
      image: this.image,
      workdir: request.workdir,
      shell: request.shell,
      network: request.network,
      limits: this.limits,
      env: request.env,
      user: this.user,
    });
    try {
      return await this.runner({
        command: "docker",
        args,
        env: this.clientEnv,
        // Kill the client slightly after the step cap; the container is removed below regardless.
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
    } finally {
      await this.runner({
        command: "docker",
        args: ["rm", "-f", "-v", name],
        env: this.clientEnv,
        timeoutMs: 30_000,
      }).catch(() => undefined);
    }
  }
}

/** Host executor: only reachable through the explicit `--sandbox=host` opt-in. Time cap only. */
export class HostExecutor implements StepExecutor {
  readonly isolation = "host" as const;
  constructor(private readonly runner: ProcessRunner) {}

  exec(request: StepExecRequest): Promise<ProcessResult> {
    return this.runner({
      command: "sh",
      args: ["-c", request.shell],
      cwd: request.workdir,
      env: request.env,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
  }
}
