import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TraceWriter,
  parseTrace,
  readTrace,
  readTraceStream,
  redactSecrets,
  redactString,
} from "./writer.js";

describe("redactSecrets & redactString", () => {
  it("redacts exact secrets from apiKeyEnvs and additionalSecrets", () => {
    const customEnv = {
      ANTHROPIC_KEY: "sk-ant-test-secret-12345",
      EMPTY_KEY: "",
    };

    const redacted = redactSecrets(
      {
        message: "Called with sk-ant-test-secret-12345 and extra-secret-pass",
        nested: { key: "sk-ant-test-secret-12345" },
      },
      {
        apiKeyEnvs: ["ANTHROPIC_KEY", "EMPTY_KEY"],
        additionalSecrets: ["extra-secret-pass"],
        env: customEnv,
      },
    );

    expect(redacted).toEqual({
      message: "Called with [REDACTED] and [REDACTED]",
      nested: { key: "[REDACTED]" },
    });
  });

  it("redacts bearer tokens in strings", () => {
    expect(redactString("Bearer my-super-secret-token")).toBe("Bearer [REDACTED]");
    expect(redactString("bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe("Bearer [REDACTED]");
  });

  it("redacts Authorization headers in strings", () => {
    expect(redactString("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
    expect(redactString("Authorization: Bearer my-secret-token")).toBe("Authorization: [REDACTED]");
    expect(redactString("proxy-authorization: token12345")).toBe("proxy-authorization: [REDACTED]");
  });

  it("redacts common API key patterns", () => {
    expect(redactString("sk-ant-api03-abcdef1234567890")).toBe("[REDACTED]");
    expect(redactString("sk-proj-abcdef12345678901234567890")).toBe("[REDACTED]");
    expect(redactString("sk-abcdef12345678901234567890")).toBe("[REDACTED]");
    expect(redactString("xai-abcdef12345678901234567890")).toBe("[REDACTED]");
    expect(redactString("AIzaSyA1234567890123456789012345678901")).toBe("[REDACTED]");
    expect(redactString("ghp_123456789012345678901234567890123456")).toBe("[REDACTED]");
    expect(redactString("github_pat_11AAAAAAA012345678901234567890123456789012")).toBe(
      "[REDACTED]",
    );
    expect(redactString("gho_123456789012345678901234567890123456")).toBe("[REDACTED]");
  });

  it("redacts sensitive object keys in deep structures", () => {
    const input = {
      apiKey: "custom-key-123",
      password: "my-password",
      authorization: "custom-auth",
      nested: {
        token: "token-abc",
        access_token: "access-token-xyz",
        safeField: "safe value",
      },
      list: [{ secret: "top-secret" }, "normal string"],
    };

    const result = redactSecrets(input);

    expect(result).toEqual({
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: {
        token: "[REDACTED]",
        access_token: "[REDACTED]",
        safeField: "safe value",
      },
      list: [{ secret: "[REDACTED]" }, "normal string"],
    });
  });

  it("redacts sensitive URL query parameters", () => {
    expect(redactString("https://api.example.com/v1?api_key=secretKey123&page=1")).toBe(
      "https://api.example.com/v1?api_key=[REDACTED]&page=1",
    );
    expect(
      redactString("https://api.example.com/v1?key=AIzaSyA1234567890123456789012345678901"),
    ).toBe("https://api.example.com/v1?key=[REDACTED]");
  });
});

describe("TraceWriter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "punch-trace-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid events to JSONL file and increments sequence numbers", async () => {
    const traceFile = path.join(tmpDir, "runs", "r1", "trace.jsonl");
    const writer = new TraceWriter({
      runId: "r1",
      filePath: traceFile,
      now: () => 1_700_000_000_000,
    });

    const e1 = await writer.write({
      kind: "run.started",
      task: { repoUrl: "https://github.com/a/b" },
      mode: "auto",
      budgets: { maxSteps: 10, maxUsd: 1, maxWallClockMs: 60_000 },
    });

    const e2 = await writer.write({
      kind: "route.skipped",
      role: "critic",
      reason: "pinned",
    });

    expect(e1.seq).toBe(0);
    expect(e1.runId).toBe("r1");
    expect(e1.ts).toBe(1_700_000_000_000);

    expect(e2.seq).toBe(1);
    expect(e2.runId).toBe("r1");
    expect(writer.getSeq()).toBe(2);

    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(2);
    expect(readEvents[0]).toEqual(e1);
    expect(readEvents[1]).toEqual(e2);
  });

  it("redacts secrets on write before persisting and before emitting to subscribers", async () => {
    const traceFile = path.join(tmpDir, "trace.jsonl");
    const receivedSubEvents: unknown[] = [];

    const writer = new TraceWriter({
      runId: "r1",
      filePath: traceFile,
      additionalSecrets: ["super-secret-key-1234"],
    });

    writer.subscribe((event) => {
      receivedSubEvents.push(event);
    });

    await writer.write({
      kind: "agent.text",
      role: "researcher",
      agentId: "a1",
      text: "Connecting with key super-secret-key-1234 and Bearer token12345",
    });

    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(1);
    const event = readEvents[0];
    if (event?.kind === "agent.text") {
      expect(event.text).toBe("Connecting with key [REDACTED] and Bearer [REDACTED]");
    } else {
      expect.fail("Expected agent.text event");
    }

    expect(receivedSubEvents).toHaveLength(1);
    expect(receivedSubEvents[0]).toEqual(readEvents[0]);
  });

  it("in-process subscriber receives events and unsubscribe works", async () => {
    const traceFile = path.join(tmpDir, "trace.jsonl");
    const writer = new TraceWriter({ runId: "r1", filePath: traceFile });

    const subscriber = vi.fn();
    const unsubscribe = writer.subscribe(subscriber);

    await writer.write({
      kind: "route.skipped",
      role: "planner",
      reason: "manual",
    });

    expect(subscriber).toHaveBeenCalledTimes(1);

    unsubscribe();

    await writer.write({
      kind: "route.skipped",
      role: "critic",
      reason: "pinned",
    });

    expect(subscriber).toHaveBeenCalledTimes(1);
    await writer.close();
  });

  it("rejects schema-invalid events on write without writing to file", async () => {
    const traceFile = path.join(tmpDir, "trace.jsonl");
    const writer = new TraceWriter({ runId: "r1", filePath: traceFile });

    // Invalid event: unknown kind
    await expect(
      writer.write({
        // @ts-expect-error Testing invalid kind
        kind: "unknown.kind",
      }),
    ).rejects.toThrow();

    await writer.close();

    // File should not exist or be empty
    if (fs.existsSync(traceFile)) {
      const content = await fs.promises.readFile(traceFile, "utf-8");
      expect(content.trim()).toBe("");
    }
  });

  it("handles concurrent writes sequentially without race conditions", async () => {
    const traceFile = path.join(tmpDir, "trace.jsonl");
    const writer = new TraceWriter({ runId: "r1", filePath: traceFile });

    const writePromises = Array.from({ length: 20 }, (_, i) =>
      writer.write({
        kind: "agent.text",
        role: "researcher",
        agentId: "a1",
        text: `Message ${i}`,
      }),
    );

    const written = await Promise.all(writePromises);
    await writer.close();

    const readEvents = await readTrace(traceFile);
    expect(readEvents).toHaveLength(20);

    for (let i = 0; i < 20; i++) {
      expect(readEvents[i]?.seq).toBe(i);
      expect(readEvents[i]).toEqual(written[i]);
    }
  });

  it("readTraceStream streams lines one by one", async () => {
    const traceFile = path.join(tmpDir, "trace.jsonl");
    const writer = new TraceWriter({ runId: "r1", filePath: traceFile });

    await writer.write({ kind: "route.skipped", role: "planner", reason: "r1" });
    await writer.write({ kind: "route.skipped", role: "critic", reason: "r2" });
    await writer.close();

    const streamed: unknown[] = [];
    for await (const event of readTraceStream(traceFile)) {
      streamed.push(event);
    }

    expect(streamed).toHaveLength(2);
  });

  it("parseTrace throws error with line number for malformed JSON or schema violations", () => {
    expect(() =>
      parseTrace(
        '{"runId":"r1","seq":0,"ts":0,"kind":"route.skipped","role":"critic","reason":"p"}\ninvalid json\n',
      ),
    ).toThrow(/Failed to parse JSON on line 2/);

    expect(() => parseTrace('{"kind": "invalid.kind", "runId": "r", "seq": 0, "ts": 0}\n')).toThrow(
      /Invalid trace event schema on line 1/,
    );
  });
});
