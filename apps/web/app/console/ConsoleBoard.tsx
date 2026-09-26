"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Config, SlotRole } from "@punch/shared";
import Header from "../components/Header";
import Footer from "../components/Footer";
import {
  EngineClient,
  EngineError,
  clearPairing,
  loadPairing,
  normalizeEngineUrl,
  savePairing,
  type Pairing,
  type SessionInfo,
  type SessionMessage,
} from "@/lib/engine/client";
import { buildApprovalContext, type ApprovalContext } from "@/lib/engine/approval-context";
import { narrateRun, type ThreadMessage } from "@/lib/engine/narration";
import { useLiveRun } from "@/lib/engine/use-live-run";
import { PairedStrip, UnpairedStrip, type PairingStatus } from "./components/PairingStrip";
import { ControlsTile, orchestratorOptions } from "./components/ControlsTile";
import {
  ApprovalTile,
  ConversationTile,
  LiveSlotsTile,
  ManualRoutingTile,
} from "./components/RunTiles";
import "./console.css";

const TERMINAL = new Set(["completed", "degraded", "aborted", "failed"]);
const MANUAL_ROLES: SlotRole[] = ["planner", "researcher", "executor", "critic"];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function ConsoleBoard() {
  const [hydrated, setHydrated] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [status, setStatus] = useState<PairingStatus>("checking");
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const [orchestratorId, setOrchestratorId] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [chaos, setChaos] = useState("none");
  const [target, setTarget] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [killing, setKilling] = useState<SlotRole | null>(null);
  const [answering, setAnswering] = useState(false);
  const [selections, setSelections] = useState<Record<string, string>>({});

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([]);
  const [localMessages, setLocalMessages] = useState<ThreadMessage[]>([]);
  const [sessionNote, setSessionNote] = useState<string | null>(null);

  const client = useMemo(() => (pairing ? new EngineClient(pairing) : null), [pairing]);
  const live = useLiveRun(pairing, runId);
  const board = live.board;
  const runActive = runId !== null && !TERMINAL.has(board.run.status) && live.error === null;

  // Restore a stored pairing, then prove it still works.
  useEffect(() => {
    setHydrated(true);
    const stored = loadPairing();
    if (stored) setPairing(stored);
  }, []);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setStatus("checking");
    client.checkPairing().then(
      () => !cancelled && setStatus("paired"),
      (err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setPairError(messageOf(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const loadConfig = useCallback(
    async (active: EngineClient) => {
      setValidating(true);
      try {
        const loaded = await active.getConfig();
        setConfig(loaded);
        setConfigError(null);
        setMode((current) => (config === null ? loaded.defaults.mode : current));
        setOrchestratorId((current) => {
          if (current) return current;
          const options = orchestratorOptions(loaded);
          return (
            options.find((option) => option.id === loaded.defaults.orchestratorAgentId)?.id ??
            options.find((option) => !option.disabled)?.id ??
            ""
          );
        });
        setSelections((current) => {
          const next = { ...current };
          for (const role of MANUAL_ROLES) {
            const pick = loaded.agents.find((agent) => agent.roles.includes(role));
            if (!next[role] && pick) next[role] = pick.id;
          }
          return next;
        });
      } catch (err) {
        setConfig(null);
        setConfigError(messageOf(err));
      } finally {
        setValidating(false);
      }
    },
    [config],
  );

  useEffect(() => {
    if (client && status === "paired") void loadConfig(client);
    // Reload only when the engine or pairing state changes, not on every config edit.
  }, [client, status]);

  const handlePair = useCallback(async (engineUrl: string, token: string) => {
    const next: Pairing = { engineUrl: normalizeEngineUrl(engineUrl), token: token.trim() };
    setPairBusy(true);
    setPairError(null);
    try {
      await new EngineClient(next).checkPairing();
      savePairing(next);
      setPairing(next);
      setStatus("paired");
    } catch (err) {
      setPairError(
        err instanceof EngineError && err.status === 401
          ? "the engine rejected that token"
          : messageOf(err),
      );
    } finally {
      setPairBusy(false);
    }
  }, []);

  const handleUnpair = useCallback(() => {
    clearPairing();
    setPairing(null);
    setConfig(null);
    setRunId(null);
    setSession(null);
    setSessionMessages([]);
    setLocalMessages([]);
    setPairError(null);
    setOrchestratorId("");
  }, []);

  // Orchestrator or mode change ends the session; the next message opens a new one.
  useEffect(() => {
    setSession(null);
    setSessionMessages([]);
  }, [orchestratorId, client]);

  const seen = useRef(0);
  useEffect(() => {
    if (!client || !session) return;
    seen.current = 0;
    return client.streamSession(
      session.id,
      (message) => {
        seen.current += 1;
        setSessionMessages((prev) => [...prev, message]);
      },
      (err) => setSessionNote(`session stream: ${err.message}`),
    );
  }, [client, session]);

  const addLocal = useCallback((message: Omit<ThreadMessage, "id" | "at">) => {
    setLocalMessages((prev) => [
      ...prev,
      { ...message, id: `local-${prev.length}-${Date.now()}`, at: Date.now() },
    ]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!client) return;
      try {
        let active = session;
        if (!active) {
          active = await client.createSession({
            ...(orchestratorId ? { orchestratorAgentId: orchestratorId } : {}),
            mode,
          });
          setSession(active);
        }
        const response = await client.sendMessage(active.id, text);
        setSessionNote(null);
        if (response.reply) addLocal({ side: "bot", from: "engine", text: response.reply });
      } catch (err) {
        if (err instanceof EngineError && err.notImplemented) {
          setSessionNote(
            "This engine has no orchestrator session yet. Runs still work from the controls.",
          );
          addLocal({ side: "me", from: "you", text });
        } else {
          setSessionNote(messageOf(err));
          throw err;
        }
      }
    },
    [client, session, orchestratorId, mode, addLocal],
  );

  const applyAssignments = useCallback(
    async (active: EngineClient, id: string) => {
      const chosen = MANUAL_ROLES.filter((role) => selections[role]).map((role) => ({
        role,
        agentId: selections[role]!,
      }));
      if (chosen.length > 0) await active.setAssignments(id, chosen);
    },
    [selections],
  );

  const startRun = useCallback(async () => {
    if (!client || starting) return;
    setStarting(true);
    setRunError(null);
    try {
      const started = await client.startRun({
        target,
        mode,
        chaos: chaos === "none" ? [] : [chaos],
      });
      setRunId(started.id);
      if (mode === "manual") await applyAssignments(client, started.id);
    } catch (err) {
      setRunError(messageOf(err));
    } finally {
      setStarting(false);
    }
  }, [client, starting, target, mode, chaos, applyAssignments]);

  const submitManual = useCallback(async () => {
    if (!client) return;
    if (runActive && runId) {
      try {
        await applyAssignments(client, runId);
      } catch (err) {
        setRunError(messageOf(err));
      }
      return;
    }
    await startRun();
  }, [client, runActive, runId, applyAssignments, startRun]);

  const kill = useCallback(
    async (role: SlotRole) => {
      if (!client || !runId) return;
      setKilling(role);
      try {
        await client.killSlot(runId, role);
      } catch (err) {
        setRunError(messageOf(err));
      } finally {
        setKilling(null);
      }
    },
    [client, runId],
  );

  const answer = useCallback(
    async (approvalId: string, decision: "approve" | "deny") => {
      if (!client || !runId) return;
      setAnswering(true);
      try {
        await client.answerApproval(runId, approvalId, decision);
      } catch (err) {
        setRunError(messageOf(err));
      } finally {
        setAnswering(false);
      }
    },
    [client, runId],
  );

  const contexts = useMemo(() => {
    const out: Record<string, ApprovalContext> = {};
    for (const approval of board.approvals) {
      out[approval.approvalId] = buildApprovalContext(live.events, approval);
    }
    return out;
  }, [board.approvals, live.events]);

  const orchestratorLabel =
    config?.agents.find((agent) => agent.id === orchestratorId)?.displayName ?? "the orchestrator";
  const thread = useMemo<ThreadMessage[]>(() => {
    const fromSession: ThreadMessage[] = sessionMessages.map((message, index) => ({
      id: `session-${index}`,
      at: message.at,
      side: message.from === "user" ? "me" : "bot",
      from: message.from === "user" ? "you" : `${orchestratorLabel} · orchestrator`,
      text: message.text,
    }));
    return [...fromSession, ...localMessages, ...narrateRun(live.events, "engine")].sort(
      (a, b) => a.at - b.at,
    );
  }, [sessionMessages, localMessages, live.events, orchestratorLabel]);

  if (!hydrated) return <main />;

  return (
    <main>
      <div
        className="bz"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 14,
          maxWidth: 1280,
          margin: "0 auto",
        }}
      >
        <Header />
        <div className="bz-grid">
          {!pairing ? (
            <UnpairedStrip error={pairError} busy={pairBusy} onPair={handlePair} />
          ) : (
            <>
              <PairedStrip
                engineUrl={pairing.engineUrl}
                status={status}
                config={config}
                configError={status === "error" ? (pairError ?? "engine unreachable") : configError}
                validating={validating}
                onValidate={() => client && void loadConfig(client)}
                onUnpair={handleUnpair}
              />
              {status === "paired" && (
                <>
                  <ControlsTile
                    config={config}
                    orchestratorId={orchestratorId}
                    onOrchestrator={setOrchestratorId}
                    mode={mode}
                    onMode={setMode}
                    chaos={chaos}
                    onChaos={setChaos}
                    target={target}
                    onTarget={setTarget}
                    running={starting || runActive}
                    onRun={() => void startRun()}
                    runError={runError}
                    autoConfirm={config?.policy.autoConfirmBelowConfidence ?? null}
                  />
                  <LiveSlotsTile
                    board={board}
                    config={config}
                    runActive={runActive}
                    onKill={(role) => void kill(role)}
                    killing={killing}
                    watchHref={runId ? `/watch?run=${encodeURIComponent(runId)}` : null}
                  />
                  <ConversationTile
                    messages={thread}
                    note={sessionNote}
                    disabled={false}
                    onSend={send}
                    orchestratorLabel={orchestratorLabel}
                  />
                  <ApprovalTile
                    board={board}
                    contexts={contexts}
                    runId={runId}
                    busy={answering}
                    onAnswer={(id, decision) => void answer(id, decision)}
                  />
                  {mode === "manual" && (
                    <ManualRoutingTile
                      config={config}
                      selections={selections}
                      onSelect={(role, agentId) =>
                        setSelections((prev) => ({ ...prev, [role]: agentId }))
                      }
                      onSubmit={() => void submitManual()}
                      busy={starting}
                      hasRun={runActive}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
        <Footer />
      </div>
    </main>
  );
}
