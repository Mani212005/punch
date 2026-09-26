import type { ErrorClass } from "@punch/shared";
import type { Jev } from "./jev.js";

export interface ErrorInput {
  text: string;
  status?: number;
  tool?: string;
}

export interface Classification {
  errorClass: ErrorClass;
  /** `jev` when Jev answered, `code` when the deterministic fallback decided. */
  source: "jev" | "code";
  confidence?: number;
}

const NOT_FOUND = /\b(not[ _-]?found|no such (file|package|repo)|does not exist|enoent|gone)\b/i;
const MALFORMED =
  /\b(malformed|unexpected token|invalid json|json parse|failed schema|schema validation|unexpected (response|shape)|truncated|cannot parse)\b/i;
const TRANSIENT =
  /\b(timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|rate.?limit|too many requests|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|try again)\b/i;

/** Deterministic classification from status code and message text. Used when Jev is down. */
export function classifyErrorByCode({ text, status }: ErrorInput): ErrorClass {
  if (status !== undefined) {
    if (status === 404 || status === 410) return "not_found";
    if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
    if (status >= 400) return "permanent";
  }
  if (NOT_FOUND.test(text)) return "not_found";
  if (MALFORMED.test(text)) return "malformed";
  if (TRANSIENT.test(text)) return "transient";
  return "permanent";
}

/**
 * Jev classifies (plan.md 3.6 step 2); if Jev is unreachable or answers off-schema, fall back
 * to code so the recovery ladder never stalls on the router itself.
 */
export async function classifyError(
  input: ErrorInput,
  deps: { jev?: Jev; signal?: AbortSignal } = {},
): Promise<Classification> {
  if (deps.jev) {
    try {
      const judged = await deps.jev.classifyError(
        input,
        deps.signal ? { signal: deps.signal } : undefined,
      );
      return { errorClass: judged.errorClass, source: "jev", confidence: judged.confidence };
    } catch {
      // fall through to the deterministic path
    }
  }
  return { errorClass: classifyErrorByCode(input), source: "code" };
}
