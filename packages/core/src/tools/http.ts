import type { z } from "zod";
import type { ErrorClass, TraceEvent } from "@punch/shared";
import { defaultClassifyError, type ErrorClassifier } from "../router/classify-error.js";

export interface HttpRequestOptions<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Zod schema to validate response data */
  schema?: z.ZodType<T>;
  /** Timeout in milliseconds for each attempt */
  timeoutMs?: number;
  /** Optional caller abort signal */
  signal?: AbortSignal;
  /** Maximum number of retry attempts on transient errors */
  maxRetries?: number;
  /** Initial retry delay in milliseconds */
  initialDelayMs?: number;
  /** Maximum retry delay in milliseconds */
  maxDelayMs?: number;
  /** Backoff multiplication factor */
  backoffFactor?: number;
  /** Custom error classifier */
  classifyError?: ErrorClassifier;
  /** Trace event sink or callback for retry events */
  traceSink?: (event: TraceEvent) => unknown;
  /** On-retry callback */
  onRetry?: (params: {
    attempt: number;
    delayMs: number;
    errorClass: ErrorClass;
    error: string;
  }) => void;
  /** Tool name for tracing */
  tool?: string;
  /** Call ID for tracing */
  callId?: string;
  /** Injectable fetch implementation */
  fetch?: typeof globalThis.fetch;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
  retries: number;
  latencyMs: number;
}

export class HttpError extends Error {
  readonly status?: number;
  readonly errorClass: ErrorClass;
  readonly responseBody?: unknown;
  readonly retries: number;
  readonly isMalformed?: boolean;
  readonly url: string;

  constructor(options: {
    message: string;
    url: string;
    status?: number;
    errorClass: ErrorClass;
    responseBody?: unknown;
    retries?: number;
    isMalformed?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "HttpError";
    this.url = options.url;
    this.status = options.status;
    this.errorClass = options.errorClass;
    this.responseBody = options.responseBody;
    this.retries = options.retries ?? 0;
    this.isMalformed = options.isMalformed;
  }
}

/**
 * Parses Retry-After header value (in seconds or HTTP date) to milliseconds.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }

  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };

    function cleanup() {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Performs HTTP request with timeout, exponential backoff on transient errors,
 * Retry-After header support, Zod validation, and error classification.
 */
export async function fetchWithRetry<T = unknown>(
  options: HttpRequestOptions<T>,
): Promise<HttpResponse<T>> {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    schema,
    timeoutMs = 15000,
    signal: callerSignal,
    maxRetries = 2,
    initialDelayMs = 200,
    maxDelayMs = 10000,
    backoffFactor = 2,
    classifyError: classifier = defaultClassifyError,
    traceSink,
    onRetry,
    tool = "http",
    callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fetch: fetchImpl = globalThis.fetch,
  } = options;

  const urlStr = url.toString();
  const startTime = Date.now();
  let attempts = 0;

  // Prepare request body
  let serializedBody: string | Uint8Array | undefined = undefined;
  const requestHeaders = new Headers(headers);

  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof Uint8Array) {
      serializedBody = body;
    } else {
      serializedBody = JSON.stringify(body);
      if (!requestHeaders.has("Content-Type")) {
        requestHeaders.set("Content-Type", "application/json");
      }
    }
  }

  while (true) {
    attempts++;
    const attemptAbortController = new AbortController();

    // Link caller signal and timeout
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        attemptAbortController.abort(
          new Error(`Request timeout after ${timeoutMs}ms: ${method} ${urlStr}`),
        );
      }, timeoutMs);
    }

    const onCallerAbort = () => {
      attemptAbortController.abort(callerSignal?.reason ?? new Error("Aborted by caller"));
    };

    if (callerSignal) {
      if (callerSignal.aborted) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        throw callerSignal.reason ?? new Error("Aborted by caller");
      }
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let response: Response | undefined;
    let responseText = "";
    let parsedJson: unknown = undefined;
    let requestError: unknown = undefined;
    let status: number | undefined;

    try {
      response = await fetchImpl(urlStr, {
        method,
        headers: requestHeaders,
        body: serializedBody,
        signal: attemptAbortController.signal,
      });
      status = response.status;
    } catch (err) {
      requestError = err;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }

    // Check if network / fetch error occurred
    if (requestError || !response) {
      const errorClass = classifier({
        status: undefined,
        error: requestError,
        message: requestError instanceof Error ? requestError.message : String(requestError),
      });

      const canRetry = errorClass === "transient" && attempts <= maxRetries;
      if (canRetry) {
        const backoffDelay = Math.min(
          maxDelayMs,
          initialDelayMs * Math.pow(backoffFactor, attempts - 1),
        );
        const delayMs = backoffDelay;

        // Trace retry
        const errMessage =
          requestError instanceof Error ? requestError.message : String(requestError);
        onRetry?.({ attempt: attempts, delayMs, errorClass, error: errMessage });
        if (traceSink) {
          try {
            await traceSink({
              runId: "tools",
              seq: 0,
              ts: Date.now(),
              kind: "tool.retry",
              callId,
              tool,
              attempt: attempts,
              delayMs,
              errorClass,
              error: errMessage,
            });
          } catch {
            // Ignore trace sink errors
          }
        }

        await sleep(delayMs, callerSignal);
        continue;
      }

      throw new HttpError({
        message: `HTTP request failed: ${requestError instanceof Error ? requestError.message : String(requestError)}`,
        url: urlStr,
        status: undefined,
        errorClass,
        retries: attempts - 1,
        cause: requestError,
      });
    }

    // Read response text
    try {
      responseText = await response.text();
    } catch (err) {
      const errorClass = classifier({
        status,
        error: err,
        message: "Failed to read response body",
      });
      throw new HttpError({
        message: `Failed to read response body from ${urlStr}: ${err instanceof Error ? err.message : String(err)}`,
        url: urlStr,
        status,
        errorClass,
        retries: attempts - 1,
        cause: err,
      });
    }

    // Handle HTTP error status codes (>= 400)
    if (!response.ok) {
      try {
        parsedJson = responseText.length > 0 ? JSON.parse(responseText) : undefined;
      } catch {
        parsedJson = responseText;
      }

      const errorClass = classifier({
        status,
        error: undefined,
        message: `HTTP ${status}: ${responseText.slice(0, 200)}`,
      });

      const canRetry = errorClass === "transient" && attempts <= maxRetries;
      if (canRetry) {
        // Check Retry-After header
        const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
        const backoffDelay = Math.min(
          maxDelayMs,
          initialDelayMs * Math.pow(backoffFactor, attempts - 1),
        );
        const delayMs = retryAfterMs !== null ? Math.min(maxDelayMs, retryAfterMs) : backoffDelay;

        const errMessage = `HTTP ${status} from ${urlStr}`;
        onRetry?.({ attempt: attempts, delayMs, errorClass, error: errMessage });
        if (traceSink) {
          try {
            await traceSink({
              runId: "tools",
              seq: 0,
              ts: Date.now(),
              kind: "tool.retry",
              callId,
              tool,
              attempt: attempts,
              delayMs,
              errorClass,
              error: errMessage,
            });
          } catch {
            // Ignore trace sink errors
          }
        }

        await sleep(delayMs, callerSignal);
        continue;
      }

      throw new HttpError({
        message: `HTTP ${status} ${response.statusText} from ${urlStr}`,
        url: urlStr,
        status,
        errorClass,
        responseBody: parsedJson,
        retries: attempts - 1,
      });
    }

    // Response is OK (2xx). Parse body.
    let data: unknown;
    if (responseText.length > 0) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }
    } else {
      data = undefined;
    }

    // Validate with Zod schema if provided
    if (schema) {
      const parseResult = schema.safeParse(data);
      if (!parseResult.success) {
        const errorMsg = `Response schema validation failed for ${urlStr}: ${parseResult.error.message}`;
        const errorClass = classifier({
          status,
          isMalformed: true,
          error: parseResult.error,
          message: errorMsg,
        });

        throw new HttpError({
          message: errorMsg,
          url: urlStr,
          status,
          errorClass: errorClass === "transient" ? "malformed" : errorClass,
          responseBody: data,
          retries: attempts - 1,
          isMalformed: true,
          cause: parseResult.error,
        });
      }
      data = parseResult.data;
    }

    return {
      data: data as T,
      status: response.status,
      headers: response.headers,
      retries: attempts - 1,
      latencyMs: Date.now() - startTime,
    };
  }
}
