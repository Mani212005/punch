import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterRunInput, AgentEvent } from "@punch/shared";
import {
  AsyncQueue,
  GARBAGE_RESULT,
  NO_CHAOS,
  ResultGate,
  errorMessage,
  killAfterTurns,
  type AgentChaos,
} from "../agent.js";

export interface CliRunnerOptions {
  binary: string;
  providerId: string;
  model?: string;
  chaos?: AgentChaos;
  buildPrompt?: (
    input: AdapterRunInput,
    correction?: { previousOutput: string; error: string },
  ) => string;
  buildArgs: (
    prompt: string,
    promptFilePath: string,
    input: AdapterRunInput,
    attempt: number,
  ) => string[];
  parseLine?: (line: string) => AgentEvent[];
  workdir?: string;
  keepWorkdir?: boolean;
  env?: Record<string, string>;
  testArgs?: string[];
}

/**
 * Extracts candidate JSON from CLI output text.
 * Searches for full text JSON, markdown ```json blocks, or balanced braces.
 */
export function extractJsonCandidate(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "empty output from CLI" };
  }

  // 1. Try parsing full text as JSON directly
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Ignore direct parse failure and try code blocks
  }

  // 2. Search for ```json ... ``` or ``` ... ``` code blocks
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]) matches.push(match[1].trim());
  }

  // Try matches in reverse (most recent first)
  for (let i = matches.length - 1; i >= 0; i--) {
    const matchStr = matches[i];
    if (matchStr) {
      try {
        return { ok: true, value: JSON.parse(matchStr) };
      } catch {
        // Ignore invalid JSON code block
      }
    }
  }

  // 3. Search for outermost JSON object { ... } or array [ ... ]
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Ignore invalid JSON slice
    }
  }

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = text.slice(firstBracket, lastBracket + 1);
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Ignore invalid JSON slice
    }
  }

  return { ok: false, error: "no valid JSON found in CLI output" };
}

/**
 * Default prompt builder formatting system prompt, task, inputs, and schema instructions.
 */
export function defaultBuildPrompt(
  input: AdapterRunInput,
  correction?: { previousOutput: string; error: string },
): string {
  const inputsStr =
    Object.keys(input.inputs).length > 0
      ? `\n\n<inputs>\n${JSON.stringify(input.inputs, null, 2)}\n</inputs>`
      : "";

  const schemaStr = `\n\n<result_schema>\n${JSON.stringify(input.resultSchema, null, 2)}\n</result_schema>`;

  const instructionStr = `\n\nCRITICAL INSTRUCTION: When your task is complete, you MUST output the final result strictly as a valid JSON value matching the <result_schema>. Output the JSON inside a \`\`\`json ... \`\`\` markdown code block or as a raw JSON object. Do not include extra comments inside the JSON.`;

  if (correction) {
    return `${input.system}\n\n<task>\n${input.task}\n</task>${inputsStr}${schemaStr}\n\n[CORRECTION REQUIRED]\nYour previous output failed validation: ${correction.error}.\n\nPrevious output:\n${correction.previousOutput}\n\nPlease fix the errors and provide the corrected output matching <result_schema> strictly.${instructionStr}`;
  }

  return `${input.system}\n\n<task>\n${input.task}\n</task>${inputsStr}${schemaStr}${instructionStr}`;
}

/**
 * Default line parser extracting text, usage, and opaque output from CLI output lines.
 */
export function defaultParseCliLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null) {
      // OpenCode `run --format json` envelope: text and tokens nest under `part`.
      // Real shape: {"type":"text","part":{"type":"text","text":"..."}} and
      // {"type":"step_finish","part":{"type":"step-finish",...,"tokens":{"input":n,"output":n}}}.
      const part = parsed.part as { type?: unknown; text?: unknown; tokens?: unknown } | undefined;
      if (part !== undefined && typeof part === "object" && part !== null) {
        if (typeof part.text === "string" && part.text.length > 0) {
          return [{ type: "text", text: part.text }];
        }
        const tokens = part.tokens as { input?: unknown; output?: unknown } | undefined;
        if (
          tokens !== undefined &&
          typeof tokens === "object" &&
          tokens !== null &&
          (typeof tokens.input === "number" || typeof tokens.output === "number")
        ) {
          return [
            {
              type: "usage",
              usage: {
                inputTokens: typeof tokens.input === "number" ? tokens.input : 0,
                outputTokens: typeof tokens.output === "number" ? tokens.output : 0,
              },
            },
          ];
        }
      }
      if (parsed.type === "text" && typeof parsed.text === "string") {
        return [{ type: "text", text: parsed.text }];
      }
      if (
        parsed.type === "content_block_delta" &&
        typeof (parsed.delta as { text?: unknown })?.text === "string"
      ) {
        return [{ type: "text", text: (parsed.delta as { text: string }).text }];
      }
      if (
        parsed.type === "delta" &&
        typeof (parsed.delta as { text?: unknown })?.text === "string"
      ) {
        return [{ type: "text", text: (parsed.delta as { text: string }).text }];
      }
      if (parsed.type === "assistant") {
        const msg = parsed.message as { content?: Array<{ type?: string; text?: string }> };
        if (Array.isArray(msg?.content)) {
          const texts = msg.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string);
          if (texts.length > 0) {
            return texts.map((text) => ({ type: "text", text }));
          }
        }
      }
      // Antigravity stream-json step_update
      const stepUpdate = parsed.step_update as
        | { text_delta?: string; usage?: { input_tokens?: number; output_tokens?: number } }
        | undefined;
      if (typeof stepUpdate?.text_delta === "string" && stepUpdate.text_delta.length > 0) {
        const events: AgentEvent[] = [{ type: "text", text: stepUpdate.text_delta }];
        if (stepUpdate.usage) {
          events.push({
            type: "usage",
            usage: {
              inputTokens: stepUpdate.usage.input_tokens ?? 0,
              outputTokens: stepUpdate.usage.output_tokens ?? 0,
            },
          });
        }
        return events;
      }
      // Antigravity stream-json result
      const resultObj = parsed.result as
        | { response?: string; usage?: { input_tokens?: number; output_tokens?: number } }
        | undefined;
      if (typeof resultObj?.response === "string" && resultObj.response.length > 0) {
        const events: AgentEvent[] = [{ type: "text", text: resultObj.response }];
        if (resultObj.usage) {
          events.push({
            type: "usage",
            usage: {
              inputTokens: resultObj.usage.input_tokens ?? 0,
              outputTokens: resultObj.usage.output_tokens ?? 0,
            },
          });
        }
        return events;
      }
      if (parsed.type === "usage" && typeof parsed.usage === "object" && parsed.usage !== null) {
        const u = parsed.usage as {
          input_tokens?: number;
          inputTokens?: number;
          output_tokens?: number;
          outputTokens?: number;
        };
        return [
          {
            type: "usage",
            usage: {
              inputTokens: u.input_tokens ?? u.inputTokens ?? 0,
              outputTokens: u.output_tokens ?? u.outputTokens ?? 0,
            },
          },
        ];
      }
      // Internal tool calls, steps, actions, progress, etc.
      return [{ type: "opaque_output", text: JSON.stringify(parsed) }];
    }
  } catch {
    // Non-JSON line: treat as text
  }

  return [{ type: "text", text: line }];
}

/**
 * Kills the entire process group / tree spawned for the CLI.
 */
function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.killed) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-proc.pid, "SIGTERM");
      const timer = setTimeout(() => {
        try {
          if (!proc.killed && proc.pid) {
            process.kill(-proc.pid, "SIGKILL");
          }
        } catch {
          // Process might have already exited
        }
      }, 500);
      timer.unref?.();
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process might have already exited
    }
  }
}

/**
 * Shared test implementation for checking CLI binary presence and version.
 */
export async function testCliBinary(
  binary: string,
  args: string[] = ["--version"],
  options?: { providerId?: string; chaos?: AgentChaos; env?: Record<string, string> },
): Promise<{ ok: boolean; detail: string }> {
  if (options?.providerId && options?.chaos?.providerDown.includes(options.providerId)) {
    return { ok: false, detail: "503 provider unavailable (chaos: provider-down)" };
  }

  return new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc?.kill("SIGKILL");
      } catch {
        // Ignore kill error on timeout
      }
      resolve({ ok: false, detail: `timeout testing ${binary}` });
    }, 10_000);
    timeout.unref?.();

    let proc: ChildProcess;
    try {
      proc = spawn(binary, args, {
        env: { ...process.env, ...options?.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      return resolve({
        ok: false,
        detail:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `binary not found: ${binary}`
            : `failed to spawn ${binary}: ${errorMessage(err)}`,
      });
    }

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        detail:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `binary not found: ${binary}`
            : `failed to spawn ${binary}: ${errorMessage(err)}`,
      });
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({
          ok: true,
          detail: stdout.trim() || stderr.trim() || `${binary} ok`,
        });
      } else {
        resolve({
          ok: false,
          detail: stderr.trim() || stdout.trim() || `exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * Shared CLI adapter execution engine.
 */
export async function* runCliAdapter(
  input: AdapterRunInput,
  options: CliRunnerOptions,
): AsyncGenerator<AgentEvent> {
  const queue = new AsyncQueue<AgentEvent>();
  const stop = new AbortController();

  void driveCli(input, options, queue, stop).finally(() => queue.end());

  try {
    yield* queue.drain();
  } finally {
    stop.abort();
  }
}

async function driveCli(
  input: AdapterRunInput,
  options: CliRunnerOptions,
  queue: AsyncQueue<AgentEvent>,
  stop: AbortController,
): Promise<void> {
  const finish = (status: "ok" | "error" | "refusal" | "max_turns", error?: string): void => {
    queue.push({ type: "done", status, ...(error === undefined ? {} : { error }) });
  };

  const chaos = options.chaos ?? NO_CHAOS;
  if (chaos.providerDown.includes(options.providerId)) {
    finish("error", `503 provider unavailable (chaos: provider-down:${options.providerId})`);
    return;
  }

  if (input.signal.aborted) {
    finish("error", "aborted");
    return;
  }

  queue.push({ type: "heartbeat" });

  let tempDir = options.workdir;
  let createdWorkdir = false;
  if (!tempDir) {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "punch-cli-"));
    createdWorkdir = true;
  }

  try {
    const gate = new ResultGate(input.resultSchema);
    const garbage = input.role !== undefined && chaos.garbage.includes(input.role);
    const killAt = killAfterTurns(chaos, input.role);
    let turns = 0;
    let lastOutput = "";
    let lastError = "";

    const buildPromptFn = options.buildPrompt ?? defaultBuildPrompt;
    const parseLineFn = options.parseLine ?? defaultParseCliLine;

    // Up to 2 attempts: initial run + one correction round
    for (let attempt = 1; attempt <= 2; attempt++) {
      turns += 1;
      if (killAt !== undefined && turns > killAt) {
        finish(
          "error",
          `agent crashed after ${turns - 1} turns (chaos: kill-after:${input.role}:${turns - 1})`,
        );
        return;
      }

      const prompt =
        attempt === 1
          ? buildPromptFn(input)
          : buildPromptFn(input, { previousOutput: lastOutput, error: lastError });

      const promptFilePath = path.join(tempDir, `prompt-attempt-${attempt}.txt`);
      await fs.promises.writeFile(promptFilePath, prompt, "utf8");

      const args = options.buildArgs(prompt, promptFilePath, input, attempt);

      let attemptText = "";
      let attemptStderr = "";
      let spawnError: Error | null = null;
      let exitCode: number | null = null;

      const proc = await new Promise<ChildProcess>((resolve, reject) => {
        try {
          const p = spawn(options.binary, args, {
            cwd: tempDir,
            env: { ...process.env, ...options.env },
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
          resolve(p);
        } catch (err) {
          reject(err);
        }
      }).catch((err) => {
        spawnError = err as Error;
        return null;
      });

      if (!proc || spawnError) {
        const isEnoent =
          spawnError && typeof spawnError === "object" && "code" in spawnError
            ? (spawnError as NodeJS.ErrnoException).code === "ENOENT"
            : false;
        finish(
          "error",
          isEnoent
            ? `missing binary: ${options.binary}`
            : `failed to spawn ${options.binary}: ${errorMessage(spawnError)}`,
        );
        return;
      }

      let procAborted = false;
      const onAbort = () => {
        procAborted = true;
        killProcessTree(proc);
      };

      input.signal.addEventListener("abort", onAbort);
      stop.signal.addEventListener("abort", onAbort);

      let stdoutBuffer = "";
      let stderrBuffer = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        queue.push({ type: "heartbeat" });
        const text = chunk.toString("utf8");
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const events = parseLineFn(line);
          for (const ev of events) {
            queue.push(ev);
            if (ev.type === "text") {
              attemptText += ev.text + "\n";
            }
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        queue.push({ type: "heartbeat" });
        const text = chunk.toString("utf8");
        stderrBuffer += text;
        attemptStderr += text;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) {
            queue.push({ type: "opaque_output", text: line });
          }
        }
      });

      const exitPromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        proc.on("error", (err) => {
          resolve({ code: null, error: err });
        });
        proc.on("close", (code) => {
          resolve({ code });
        });
      });

      const outcome = await exitPromise;
      input.signal.removeEventListener("abort", onAbort);
      stop.signal.removeEventListener("abort", onAbort);

      if (stdoutBuffer.trim()) {
        const events = parseLineFn(stdoutBuffer);
        for (const ev of events) {
          queue.push(ev);
          if (ev.type === "text") {
            attemptText += ev.text + "\n";
          }
        }
      }
      if (stderrBuffer.trim()) {
        queue.push({ type: "opaque_output", text: stderrBuffer });
      }

      if (procAborted || input.signal.aborted || stop.signal.aborted) {
        finish("error", "aborted");
        return;
      }

      if (outcome.error) {
        const isEnoent =
          typeof outcome.error === "object" && "code" in outcome.error
            ? (outcome.error as NodeJS.ErrnoException).code === "ENOENT"
            : false;
        finish(
          "error",
          isEnoent
            ? `missing binary: ${options.binary}`
            : `failed to spawn ${options.binary}: ${errorMessage(outcome.error)}`,
        );
        return;
      }

      exitCode = outcome.code;
      if (exitCode !== 0) {
        finish(
          "error",
          `process exited with code ${exitCode}: ${attemptStderr.trim() || attemptText.trim() || "unknown error"}`,
        );
        return;
      }

      if (killAt !== undefined && turns >= killAt) {
        finish(
          "error",
          `agent crashed after ${turns} turns (chaos: kill-after:${input.role}:${turns})`,
        );
        return;
      }

      const extracted = extractJsonCandidate(attemptText);
      const candidate = garbage ? GARBAGE_RESULT : extracted.ok ? extracted.value : GARBAGE_RESULT;
      const verdict = gate.submit(candidate);

      if (verdict.ok) {
        queue.push({ type: "result", output: gate.value });
        finish("ok");
        return;
      }

      if (verdict.terminal) {
        finish("error", gate.failure ?? verdict.error);
        return;
      }

      // First attempt failed, prepare correction round
      lastOutput = attemptText.trim();
      lastError = extracted.ok ? verdict.error : extracted.error;
      queue.push({
        type: "opaque_output",
        text: `Result schema validation failed: ${lastError}. Starting correction round.`,
      });
    }

    if (gate.failure !== null) {
      finish("error", gate.failure);
    } else {
      finish("error", `reached maxTurns (${input.maxTurns}) without valid result`);
    }
  } finally {
    if (createdWorkdir && !options.keepWorkdir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temporary directory cleanup failure
      }
    }
  }
}
