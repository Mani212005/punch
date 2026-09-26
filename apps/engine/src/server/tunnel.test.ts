import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildViewerEventsUrl,
  buildViewerTraceUrl,
  buildViewerUrl,
  CLOUDFLARED_INSTALL_GUIDANCE,
  parseViewerUrl,
  startQuickTunnel,
} from "./tunnel.js";

function fakeSpawn(behavior: (child: EventEmitter & Record<string, unknown>) => void): unknown {
  return vi.fn().mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    behavior(child);
    return child;
  });
}

describe("tunnel viewer URLs", () => {
  it("builds a viewer URL carrying only the viewer token", () => {
    const url = buildViewerUrl("https://abc.trycloudflare.com/", "view-123");
    expect(url).toBe("https://abc.trycloudflare.com/?token=view-123");
    expect(url).not.toContain("pair");
  });

  it("builds per-run events/trace URLs through the tunnel base", () => {
    expect(buildViewerEventsUrl("https://abc.trycloudflare.com", "run-1", "view-123")).toBe(
      "https://abc.trycloudflare.com/runs/run-1/events?token=view-123",
    );
    expect(buildViewerTraceUrl("https://abc.trycloudflare.com", "run-1", "view-123")).toBe(
      "https://abc.trycloudflare.com/runs/run-1/trace?token=view-123",
    );
  });

  it("parses base, events, and trace viewer URLs", () => {
    expect(parseViewerUrl("https://abc.trycloudflare.com/?token=view-123")).toEqual({
      engineBase: "https://abc.trycloudflare.com",
      runId: null,
      token: "view-123",
    });
    expect(
      parseViewerUrl("https://abc.trycloudflare.com/runs/run-1/events?token=view-123"),
    ).toEqual({
      engineBase: "https://abc.trycloudflare.com",
      runId: "run-1",
      token: "view-123",
    });
    expect(parseViewerUrl("https://abc.trycloudflare.com/runs/run-1/trace?token=view-123")).toEqual(
      {
        engineBase: "https://abc.trycloudflare.com",
        runId: "run-1",
        token: "view-123",
      },
    );
    expect(parseViewerUrl("not a url")).toEqual({ engineBase: "", runId: null, token: null });
  });
});

describe("startQuickTunnel", () => {
  it("resolves with the public URL once cloudflared prints it", async () => {
    const spawnFn = fakeSpawn((child) => {
      const stderr = child.stderr as EventEmitter;
      setImmediate(() =>
        stderr.emit(
          "data",
          "2026-09-26 INF Registered tunnel connection\n2026-09-26 INF + https://abc-123.trycloudflare.com\n",
        ),
      );
    });
    const handle = await startQuickTunnel({
      localUrl: "http://127.0.0.1:4141",
      spawnFn: spawnFn as never,
    });
    expect(handle.publicUrl).toBe("https://abc-123.trycloudflare.com");
    await handle.stop();
  });

  it("reports install guidance when cloudflared is missing", async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      const err = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
      setImmediate(() => (child as EventEmitter).emit("error", err));
      return child;
    });
    await expect(
      startQuickTunnel({ localUrl: "http://127.0.0.1:4141", spawnFn: spawnFn as never }),
    ).rejects.toThrow(CLOUDFLARED_INSTALL_GUIDANCE);
  });

  it("throws synchronously-thrown spawn errors with install guidance", async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error("nope");
    });
    await expect(
      startQuickTunnel({ localUrl: "http://127.0.0.1:4141", spawnFn: spawnFn as never }),
    ).rejects.toThrow(CLOUDFLARED_INSTALL_GUIDANCE);
  });
});
