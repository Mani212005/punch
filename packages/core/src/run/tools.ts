import type { ErrorClass } from "@punch/shared";
import { HttpError } from "../tools/http.js";
import { TOOL_SPECS, executeTool, type ToolExecutionResult } from "../tools/registry.js";
import type { EmitEvent } from "./slot.js";

export class ToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`tool ${tool} timed out after ${ms}ms`);
    this.name = "ToolTimeoutError";
  }
}

/** Rejects when the signal aborts; the work keeps running but nobody waits for it. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * `executeTool` with a per-call deadline and no exceptions: a hung tool times out, and a tool
 * that throws (chaos `500`, `hang`) comes back as a failed result with its `tool.result` traced,
 * so an agent sees a failure it can degrade on instead of the run crashing.
 */
export function createGuardedToolRunner(options: {
  timeoutMs: number;
  emit: EmitEvent;
}): typeof executeTool {
  return (async (name, input, context = {}) => {
    const controller = new AbortController();
    const relay = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) relay();
    else context.signal?.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(
      () => controller.abort(new ToolTimeoutError(name, options.timeoutMs)),
      options.timeoutMs,
    );
    const started = Date.now();
    try {
      return await raceAbort(
        executeTool(name, input, { ...context, signal: controller.signal }),
        controller.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorClass: ErrorClass =
        err instanceof HttpError
          ? err.errorClass
          : err instanceof ToolTimeoutError
            ? "transient"
            : "permanent";
      const retries = err instanceof HttpError ? err.retries : 0;
      const callId = context.callId ?? "unknown";
      const latencyMs = Date.now() - started;
      if (TOOL_SPECS[name]) {
        options.emit({
          kind: "tool.result",
          callId,
          tool: name,
          ok: false,
          cached: false,
          latencyMs,
          retries,
          error: message,
          errorClass,
        });
      }
      const failed: ToolExecutionResult = {
        ok: false,
        cached: false,
        latencyMs,
        retries,
        error: message,
        errorClass,
        callId,
        status: "degraded",
      };
      return failed;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", relay);
    }
  }) as typeof executeTool;
}
