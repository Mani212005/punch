import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import type { TraceEvent } from "@punch/shared";
import ConsoleBoard from "../console/ConsoleBoard";
import { PAIRING_STORAGE_KEY, runBodyFor } from "@/lib/engine/client";
import { buildApprovalContext } from "@/lib/engine/approval-context";
import { narrateRun } from "@/lib/engine/narration";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const CONFIG = {
  version: 1,
  providers: [{ id: "anthropic", kind: "anthropic", apiKeyEnv: "K" }],
  agents: [
    {
      id: "opus",
      displayName: "Opus",
      providerId: "anthropic",
      model: "m",
      costTier: "high",
      roles: ["orchestrator", "planner", "researcher", "executor", "critic"],
      strengths: "",
    },
  ],
  policy: {
    pins: [],
    fallbackChains: [],
    rules: [],
    preferences: "",
    distinctCritic: false,
    autoConfirmBelowConfidence: 0.6,
    maxReplacementsPerSlot: 2,
    stallAfterMs: { api: 1, cli: 1 },
  },
  budgets: { maxSteps: 1, maxUsd: 1, maxWallClockMs: 1 },
  defaults: { mode: "auto", orchestratorAgentId: "opus" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("console page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows only the pairing strip when unpaired", async () => {
    render(<ConsoleBoard />);
    expect(await screen.findByRole("form", { name: "pair with engine" })).toBeInTheDocument();
    expect(screen.queryByTestId("controls-tile")).toBeNull();
    expect(screen.queryByTestId("approval-tile")).toBeNull();
  });

  it("reports a rejected token and stays unpaired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "unauthorized" }, 401)),
    );
    render(<ConsoleBoard />);
    fireEvent.change(await screen.findByPlaceholderText("pairing token"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected that token");
    expect(window.localStorage.getItem(PAIRING_STORAGE_KEY)).toBeNull();
  });

  it("restores a stored pairing, shows the config chip, and degrades when sessions are missing", async () => {
    window.localStorage.setItem(
      PAIRING_STORAGE_KEY,
      JSON.stringify({ engineUrl: "http://e:1", token: "t" }),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/runs")) return json({ runs: [] });
      if (url.endsWith("/config")) return json({ config: CONFIG });
      if (url.endsWith("/sessions") && init?.method === "POST") return json({ error: "nope" }, 501);
      return json({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ConsoleBoard />);
    expect(await screen.findByTestId("config-chip")).toHaveTextContent(
      "config valid · 1 agents · 1 providers",
    );
    expect(screen.getByTestId("controls-tile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kill researcher" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("session-note")).toHaveTextContent("no orchestrator session yet"),
    );
    expect(screen.getByRole("log", { name: "conversation" })).toHaveTextContent("hello");
  });
});

describe("engine helpers", () => {
  it("builds run bodies for repos and fixtures", () => {
    expect(runBodyFor({ target: "https://github.com/a/b", mode: "auto", chaos: [] })).toEqual({
      mode: "auto",
      chaos: [],
      repoUrl: "https://github.com/a/b",
    });
    expect(runBodyFor({ target: "fixture:/x/y", mode: "manual", chaos: ["stall:critic"] })).toEqual(
      { mode: "manual", chaos: ["stall:critic"], fixture: "/x/y" },
    );
  });

  it("joins an approval with its proposal and sandbox result", () => {
    const events = [
      {
        runId: "r",
        seq: 1,
        ts: 1,
        kind: "sandbox.finished",
        findingId: "f1",
        validation: {
          isolation: "docker",
          baseline: null,
          candidate: {
            counts: { total: 4, passed: 4, failed: 0, skipped: 0 },
          },
          newFailures: [],
          fixedFailures: [],
          changedFiles: [],
          verdict: "PASS",
          evidenceIds: ["ev-9"],
        },
      },
      {
        runId: "r",
        seq: 2,
        ts: 2,
        kind: "remediation.proposed",
        findingId: "f1",
        action: "pull_request",
        dependency: "qs",
        from: "6.5.2",
        to: "6.9.7",
        approvalId: "a1",
        summary: "upgrade qs",
      },
    ] as unknown as TraceEvent[];
    const context = buildApprovalContext(events, { approvalId: "a1", payload: { title: "t" } });
    expect(context).toMatchObject({
      action: "fix pull request",
      validation: "PASS · isolation docker · no new failures",
      tests: "4/4 passed, 0 failed, 0 skipped",
      evidence: "ev-9",
    });
    expect(context.payload).toContain('"title": "t"');
  });

  it("narrates a kill and a takeover in plain words", () => {
    const events = [
      {
        runId: "r",
        seq: 1,
        ts: 1,
        kind: "slot.failed",
        role: "researcher",
        agentId: "opus",
        reason: { kind: "operator_kill", detail: "killed" },
      },
      {
        runId: "r",
        seq: 2,
        ts: 2,
        kind: "slot.replaced",
        role: "researcher",
        subtaskId: "s3",
        failedAgentId: "opus",
        replacementAgentId: "gemini",
        takeoverMs: 1800,
      },
    ] as unknown as TraceEvent[];
    const text = narrateRun(events).map((m) => m.text);
    expect(text[0]).toBe("You killed the researcher (opus).");
    expect(text[1]).toBe("gemini took over the researcher on s3 in 1.8s.");
  });
});
