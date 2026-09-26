"use client";

import React from "react";
import type { Config, SlotRole } from "@punch/shared";
import type { BoardState, SlotLaneState } from "@/lib/trace/types";
import type { ThreadMessage } from "@/lib/engine/narration";
import type { ApprovalContext } from "@/lib/engine/approval-context";
import { CLI_KINDS } from "./ControlsTile";

const PRIMARY_ROLES: SlotRole[] = ["planner", "researcher", "executor", "critic"];

function title(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function agentName(config: Config | null, agentId?: string): string {
  if (!agentId) return "unassigned";
  return config?.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
}

interface SlotsProps {
  board: BoardState;
  config: Config | null;
  runActive: boolean;
  onKill: (role: SlotRole) => void;
  killing: SlotRole | null;
  watchHref: string | null;
}

function slotClass(slot: SlotLaneState): string {
  if (slot.state === "running") return "running";
  if (slot.state === "failed" || slot.state === "exhausted") return "failed";
  if (slot.state === "completed") return "done";
  return "";
}

export function LiveSlotsTile({
  board,
  config,
  runActive,
  onKill,
  killing,
  watchHref,
}: SlotsProps) {
  const roles = (Object.keys(board.slots) as SlotRole[]).filter(
    (role) =>
      PRIMARY_ROLES.includes(role) ||
      board.slots[role].agentId !== undefined ||
      board.slots[role].state !== "assigned",
  );
  return (
    <div className="bz-tile c5" style={{ gap: 6 }} data-testid="slots-tile">
      <div className="bz-label">live slots · kill is the demo lever</div>
      {roles.map((role) => {
        const slot = board.slots[role];
        const running = slot.state === "running";
        const detail = running
          ? `running${slot.currentSubtaskId ? ` · ${slot.currentSubtaskId}` : ""}`
          : slot.state === "assigned"
            ? "waiting"
            : slot.state;
        return (
          <div
            key={role}
            className={`bz-agent ${slotClass(slot)}`}
            style={{ gridTemplateColumns: "1fr auto" }}
            data-testid={`slot-${role}`}
            data-state={slot.state}
          >
            <span className="role">{title(role)}</span>
            <button
              className={`bz-btn sm${running && runActive ? " danger" : ""}`}
              type="button"
              aria-label={`Kill ${role}`}
              disabled={!(running && runActive) || killing === role}
              onClick={() => onKill(role)}
            >
              Kill
            </button>
            <span className="who">
              {agentName(config, slot.agentId)} · {detail}
              {slot.replaced.length > 0 ? ` · ${slot.replaced.length} replaced` : ""}
            </span>
          </div>
        );
      })}
      {watchHref && (
        <a className="bz-mono" style={{ fontSize: 11 }} href={watchHref}>
          Open this run on the watch board
        </a>
      )}
    </div>
  );
}

interface ConversationProps {
  messages: ThreadMessage[];
  note: string | null;
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
  orchestratorLabel: string;
}

export function ConversationTile({
  messages,
  note,
  disabled,
  onSend,
  orchestratorLabel,
}: ConversationProps) {
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const threadRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  return (
    <div className="bz-tile c7" style={{ gap: 8 }} data-testid="conversation-tile">
      <div className="bz-label">conversation · orchestrator narrates, you decide</div>
      <div className="pc-thread" ref={threadRef} role="log" aria-label="conversation">
        {messages.length === 0 && (
          <div className="bz-mono bz-muted" style={{ fontSize: 11 }}>
            No messages yet. Start a run or message {orchestratorLabel}.
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`bz-msg ${message.side}${message.tone ? ` ${message.tone}` : ""}`}
          >
            <span className="from">{message.from}</span>
            {message.text}
          </div>
        ))}
      </div>
      {note && (
        <div className="bz-mono bz-muted" style={{ fontSize: 10 }} data-testid="session-note">
          {note}
        </div>
      )}
      <form
        className="pc-send"
        onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value || sending) return;
          setSending(true);
          void onSend(value)
            .then(() => setText(""))
            .finally(() => setSending(false));
        }}
      >
        <input
          className="bz-input"
          aria-label="message"
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message the orchestrator or give a new task"
        />
        <button
          className="bz-btn primary"
          type="submit"
          disabled={disabled || sending || !text.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
}

interface ApprovalProps {
  board: BoardState;
  contexts: Record<string, ApprovalContext>;
  runId: string | null;
  busy: boolean;
  onAnswer: (approvalId: string, decision: "approve" | "deny") => void;
}

export function ApprovalTile({ board, contexts, runId, busy, onAnswer }: ApprovalProps) {
  const pending = board.approvals.find((approval) => approval.status === "pending");
  const last = board.approvals[board.approvals.length - 1];
  if (!pending) {
    return (
      <div className="bz-tile c5" data-testid="approval-tile" data-pending="false">
        <div className="bz-label">
          <span className="bz-glyph wait" />
          approval · irreversible action
        </div>
        <div className="bz-mono bz-muted" style={{ fontSize: 11 }}>
          {last
            ? `${last.tool} ${last.status}${last.reason ? `: ${last.reason}` : ""}. Nothing pending.`
            : "Nothing pending. Irreversible tools pause here with their exact payload."}
        </div>
        <div className="bz-mono bz-muted" style={{ fontSize: 10 }}>
          No auto-approve exists.
        </div>
      </div>
    );
  }
  const context = contexts[pending.approvalId];
  const facts: [string, string | undefined][] = [
    ["proposal", context?.summary],
    ["validation", context?.validation],
    ["tests", context?.tests],
    ["risk", context?.risk],
    ["evidence", context?.evidence],
  ];
  return (
    <div className="bz-tile c5 pc-approval" data-testid="approval-tile" data-pending="true">
      <div className="bz-label">
        <span className="bz-glyph warn" />
        approval · irreversible action
      </div>
      <div className="bz-h3" style={{ fontSize: 15 }}>
        {pending.tool}
      </div>
      <pre className="pc-payload" data-testid="approval-payload">
        {context?.payload ?? JSON.stringify(pending.payload, null, 2)}
      </pre>
      <dl className="pc-facts">
        {facts
          .filter((fact): fact is [string, string] => fact[1] !== undefined)
          .map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
      </dl>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          className="bz-btn danger"
          type="button"
          disabled={busy}
          onClick={() => onAnswer(pending.approvalId, "deny")}
        >
          Deny
        </button>
        <button
          className="bz-btn primary"
          type="button"
          disabled={busy}
          onClick={() => onAnswer(pending.approvalId, "approve")}
        >
          Approve
        </button>
      </div>
      <div className="bz-mono bz-muted" style={{ fontSize: 10 }}>
        No auto-approve exists. CLI: punch approve {runId ?? "<run>"} {pending.approvalId}
      </div>
    </div>
  );
}

const MANUAL_ROLES: SlotRole[] = ["planner", "researcher", "executor", "critic"];

interface ManualProps {
  config: Config | null;
  selections: Record<string, string>;
  onSelect: (role: SlotRole, agentId: string) => void;
  onSubmit: () => void;
  busy: boolean;
  hasRun: boolean;
}

export function ManualRoutingTile({
  config,
  selections,
  onSelect,
  onSubmit,
  busy,
  hasRun,
}: ManualProps) {
  const kinds = new Map(config?.providers.map((provider) => [provider.id, provider.kind]) ?? []);
  return (
    <div className="bz-tile c5 alt" style={{ gap: 6 }} data-testid="manual-tile">
      <div className="bz-label">manual mode · you set every role</div>
      {MANUAL_ROLES.map((role) => {
        const agents = (config?.agents ?? []).filter((agent) => agent.roles.includes(role));
        return (
          <div className="bz-prob" style={{ gridTemplateColumns: "80px minmax(0,1fr)" }} key={role}>
            <span>{title(role)}</span>
            <select
              className="bz-select"
              aria-label={`${role} agent`}
              value={selections[role] ?? ""}
              onChange={(event) => onSelect(role, event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                  {CLI_KINDS.has(kinds.get(agent.providerId) ?? "") ? " · cli" : ""}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <button className="bz-btn primary" type="button" disabled={busy} onClick={onSubmit}>
        {hasRun ? "Apply these assignments" : "Run with these assignments"}
      </button>
    </div>
  );
}
