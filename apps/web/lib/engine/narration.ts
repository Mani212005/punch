import type { TraceEvent } from "@punch/shared";

export interface ThreadMessage {
  id: string;
  side: "me" | "bot";
  tone?: "warn";
  from: string;
  text: string;
  at: number;
}

/**
 * Plain-words narration of the run trace for the conversation tile. It says
 * only what the trace records; the orchestrator session (C2) adds its own
 * narration on top of the session stream.
 */
export function narrateRun(events: readonly TraceEvent[], label = "engine"): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const event of events) {
    const id = `run-${event.runId}-${event.seq}`;
    const say = (text: string, tone?: "warn") =>
      out.push({ id, at: event.ts, side: "bot", ...(tone ? { tone } : {}), from: label, text });
    switch (event.kind) {
      case "run.started":
        say(`Run ${event.runId} started on ${event.task.repoUrl} in ${event.mode} mode.`);
        break;
      case "plan.created":
        say(`Planner produced ${event.subtasks.length} subtasks.`);
        break;
      case "slot.failed":
        say(
          event.reason.kind === "operator_kill"
            ? `You killed the ${event.role} (${event.agentId}).`
            : `The ${event.role} (${event.agentId}) ${event.reason.kind}: ${event.reason.detail}`,
          "warn",
        );
        break;
      case "slot.replaced":
        say(
          `${event.replacementAgentId} took over the ${event.role}${event.subtaskId ? ` on ${event.subtaskId}` : ""} in ${(event.takeoverMs / 1000).toFixed(1)}s.`,
          "warn",
        );
        break;
      case "slot.exhausted":
        say(`The ${event.role} slot is exhausted: ${event.reason}`, "warn");
        break;
      case "approval.requested":
        say(`Approval needed for ${event.tool}. Nothing is written until you answer.`, "warn");
        break;
      case "approval.granted":
        say(`Approved ${event.approvalId}.`);
        break;
      case "approval.denied":
        say(`Denied ${event.approvalId}${event.reason ? `: ${event.reason}` : ""}. No write made.`);
        break;
      case "run.finished":
        say(`Run ${event.status}.${event.summary ? ` ${event.summary}` : ""}`);
        break;
      default:
        break;
    }
  }
  return out;
}
