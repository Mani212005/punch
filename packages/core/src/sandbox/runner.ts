import { spawn } from "node:child_process";

/** Process runner seam: every sandbox command goes through it so tests can inject a fake. */
export interface RunRequest {
  command: string;
  args: string[];
  cwd?: string;
  /** Exact environment for the child. When omitted the child inherits nothing sensitive: see nodeRunner. */
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  /** Combined stdout and stderr, tail-capped. */
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export type ProcessRunner = (request: RunRequest) => Promise<RunResult>;

const MAX_OUTPUT_CHARS = 1_000_000;

/** Default runner: spawn without a shell, in its own process group so a timeout kills the tree. */
export const nodeRunner: ProcessRunner = (request) =>
  new Promise<RunResult>((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const posix = process.platform !== "win32";

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env ?? {},
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    });

    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, output, timedOut, aborted, durationMs: Date.now() - started });
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
