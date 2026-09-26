import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { fetchWithRetry, HttpError, parseRetryAfter } from "./http.js";
import type { TraceEvent } from "@punch/shared";

describe("HTTP Core Transport (fetchWithRetry)", () => {
  it("succeeds on first attempt for 200 OK responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "punch", version: "1.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await fetchWithRetry({
      url: "https://api.test/pkg",
      fetch: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ name: "punch", version: "1.0.0" });
    expect(res.retries).toBe(0);
  });

  it("retries on 500 Internal Server Error with exponential backoff and succeeds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const retriesRecorded: Array<{ attempt: number; delayMs: number; errorClass: string }> = [];
    const traceEvents: TraceEvent[] = [];

    const res = await fetchWithRetry({
      url: "https://api.test/retry",
      initialDelayMs: 10,
      maxRetries: 2,
      fetch: mockFetch,
      onRetry: (p) => retriesRecorded.push(p),
      traceSink: (e) => traceEvents.push(e),
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(res.retries).toBe(1);

    expect(retriesRecorded).toHaveLength(1);
    expect(retriesRecorded[0]?.attempt).toBe(1);
    expect(retriesRecorded[0]?.errorClass).toBe("transient");

    expect(traceEvents).toHaveLength(1);
    expect(traceEvents[0]?.kind).toBe("tool.retry");
  });

  it("retries on 429 Rate Limited and honors Retry-After header in seconds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ rateLimited: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await fetchWithRetry({
      url: "https://api.test/rate-limit",
      initialDelayMs: 10,
      maxRetries: 3,
      fetch: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(res.retries).toBe(2);
    expect(res.data).toEqual({ rateLimited: false });
  });

  it("retries on network errors (fetch failed) up to maxRetries", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return new Response(JSON.stringify({ recovered: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await fetchWithRetry({
      url: "https://api.test/network-error",
      initialDelayMs: 10,
      maxRetries: 2,
      fetch: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.data).toEqual({ recovered: true });
    expect(res.retries).toBe(1);
  });

  it("does NOT retry on permanent errors (400 Bad Request, 401, 403, 404)", async () => {
    const mockFetch404 = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));

    await expect(
      fetchWithRetry({
        url: "https://api.test/nonexistent",
        maxRetries: 3,
        fetch: mockFetch404,
      }),
    ).rejects.toThrow(HttpError);

    expect(mockFetch404).toHaveBeenCalledTimes(1);

    const mockFetch403 = vi
      .fn()
      .mockResolvedValue(new Response("Forbidden", { status: 403, statusText: "Forbidden" }));

    try {
      await fetchWithRetry({
        url: "https://api.test/forbidden",
        maxRetries: 3,
        fetch: mockFetch403,
      });
      expect.unreachable("Should have thrown HttpError");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(403);
      expect(httpErr.errorClass).toBe("permanent");
      expect(httpErr.retries).toBe(0);
    }
    expect(mockFetch403).toHaveBeenCalledTimes(1);
  });

  it("validates response with Zod schema and classifies wrong-shape 200 as malformed", async () => {
    const TestSchema = z.object({
      id: z.string(),
      count: z.number(),
    });

    // Valid response passes
    const validFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "item-123", count: 42 }), { status: 200 }),
      );

    const validRes = await fetchWithRetry({
      url: "https://api.test/valid",
      schema: TestSchema,
      fetch: validFetch,
    });

    expect(validRes.data).toEqual({ id: "item-123", count: 42 });

    // Wrong-shape response throws HttpError with errorClass: 'malformed'
    const invalidFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 123, count: "not-a-number" }), { status: 200 }),
      );

    try {
      await fetchWithRetry({
        url: "https://api.test/invalid",
        schema: TestSchema,
        fetch: invalidFetch,
      });
      expect.unreachable("Should have failed schema validation");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.isMalformed).toBe(true);
      expect(httpErr.errorClass).toBe("malformed");
    }
  });

  it("aborts when per-call timeout expires", async () => {
    const hangingFetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((resolve, reject) => {
        const signal: AbortSignal = options.signal;
        signal.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("Timeout aborted"));
        });
      });
    });

    await expect(
      fetchWithRetry({
        url: "https://api.test/slow",
        timeoutMs: 30,
        maxRetries: 0,
        fetch: hangingFetch,
      }),
    ).rejects.toThrow();
  });

  it("supports external caller AbortSignal", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response("OK", { status: 200 });
    });

    controller.abort(new Error("User cancelled"));

    await expect(
      fetchWithRetry({
        url: "https://api.test/cancel",
        signal: controller.signal,
        fetch: mockFetch,
      }),
    ).rejects.toThrow("User cancelled");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses Retry-After header correctly for seconds and HTTP date", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("invalid")).toBeNull();

    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const parsedDateMs = parseRetryAfter(futureDate);
    expect(parsedDateMs).toBeGreaterThan(5000);
    expect(parsedDateMs).toBeLessThanOrEqual(10000);
  });
});
