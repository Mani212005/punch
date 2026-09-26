import type {
  AgentEvent,
  EvidenceRecord,
  Finding,
  Handoff,
  HandoffSummary,
  FailureReason,
  Subtask,
  ToolResultSummary,
} from "@punch/shared";
import { computeInputHash } from "../tools/cache.js";

export interface LoggedCall {
  callId: string;
  tool: string;
  input: unknown;
  ok?: boolean;
  output?: unknown;
}

const EXCERPT_CHARS = 300;
const NOTES_CHARS = 2000;
/** Tools that read repository files; their `path` input is a file the agent already inspected. */
const FILE_TOOL = /(content|file|source|read_?file|blob)/i;
const NOT_A_FILE_TOOL = /^(read|list)_blackboard$|^get_tool_result$/;
const API_TOOL = /^(github|osv|npm|get_|query_)/;

/**
 * What one slot's agents did on one subtask, accumulated across attempts and predecessors:
 * every tool call with its outcome, and the last thing the agent said. The handoff is built
 * from it, so a replacement inherits the whole trail and not only the last attempt's.
 */
export class AttemptLog {
  private readonly calls = new Map<string, LoggedCall>();
  private lastText: string | null = null;

  observe(event: AgentEvent): void {
    if (event.type === "text") {
      this.lastText = event.text;
    } else if (event.type === "tool_call") {
      this.calls.set(event.callId, { callId: event.callId, tool: event.tool, input: event.input });
    } else if (event.type === "tool_result") {
      const call = this.calls.get(event.callId) ?? {
        callId: event.callId,
        tool: event.tool,
        input: undefined,
      };
      this.calls.set(event.callId, { ...call, ok: event.ok, output: event.output });
    }
  }

  get notes(): string | null {
    return this.lastText;
  }

  successfulCalls(): LoggedCall[] {
    return [...this.calls.values()].filter((c) => c.ok === true);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function excerpt(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  return clip(text, EXCERPT_CHARS);
}

/** Repository paths the predecessor read, from the inputs of its successful file-reading calls. */
export function filesInspectedBy(calls: LoggedCall[]): string[] {
  const files = new Set<string>();
  for (const call of calls) {
    if (NOT_A_FILE_TOOL.test(call.tool) || !FILE_TOOL.test(call.tool)) continue;
    const input = call.input as { path?: unknown; file?: unknown } | null | undefined;
    const path = input?.path ?? input?.file;
    if (typeof path === "string" && path) files.add(path);
  }
  return [...files];
}

/** Evidence the predecessor gathered: one record per successful call, files as `file` evidence. */
export function evidenceRecordsFor(calls: LoggedCall[], now: number): EvidenceRecord[] {
  return calls
    .filter((c) => !NOT_A_FILE_TOOL.test(c.tool))
    .map((call) => {
      const files = filesInspectedBy([call]);
      const kind: EvidenceRecord["kind"] = files.length
        ? "file"
        : API_TOOL.test(call.tool)
          ? "api_response"
          : "tool_result";
      return {
        id: `ev-${call.callId}`,
        kind,
        ref: files[0] ?? call.callId,
        excerpt: excerpt(call.output),
        fetchedAt: now,
        tool: call.tool,
      };
    });
}

export interface BuildHandoffOptions {
  subtask: Subtask;
  reason: FailureReason;
  predecessor: Handoff["predecessor"];
  inputs: Handoff["inputs"];
  log: AttemptLog;
  /** Overrides the log's last assistant text, e.g. the rejected draft. */
  partialNotes?: string | null;
  criticFindings?: Finding[] | null;
  budget: Handoff["budget"];
  now: number;
}

/** plan.md 2.4, extended by the addendum: everything the replacement needs to continue, not restart. */
export function buildHandoff(options: BuildHandoffOptions): Handoff {
  const calls = options.log.successfulCalls();
  const cachedToolResults: ToolResultSummary[] = calls.map((c) => ({
    tool: c.tool,
    inputHash: computeInputHash(c.tool, c.input),
    input: c.input,
    output: c.output,
  }));
  const notes = options.partialNotes !== undefined ? options.partialNotes : options.log.notes;
  return {
    subtask: options.subtask,
    reason: options.reason,
    predecessor: options.predecessor,
    inputs: options.inputs,
    cachedToolResults,
    partialNotes: notes === null ? null : clip(notes, NOTES_CHARS),
    filesInspected: filesInspectedBy(calls),
    evidenceRecords: evidenceRecordsFor(calls, options.now),
    criticFindings: options.criticFindings ?? null,
    budget: options.budget,
  };
}

/** The trace's view of a handoff (`slot.replacing`). */
export function summarizeHandoff(handoff: Handoff): HandoffSummary {
  return {
    inputKeys: Object.keys(handoff.inputs),
    cachedResultCount: handoff.cachedToolResults.length,
    partialNotes: handoff.partialNotes,
    filesInspectedCount: handoff.filesInspected.length,
    evidenceRecordCount: handoff.evidenceRecords.length,
    criticFindings: handoff.criticFindings,
    budget: handoff.budget,
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The takeover banner's line, for example "2 files, 3 API responses, 5 evidence records". */
export function describeRecovered(handoff: Handoff): string {
  const apiResponses = handoff.cachedToolResults.length - handoff.filesInspected.length;
  return [
    plural(handoff.filesInspected.length, "file"),
    plural(Math.max(0, apiResponses), "API response"),
    plural(handoff.evidenceRecords.length, "evidence record"),
  ].join(", ");
}

/** Instructions that go with the handoff so the replacement continues the same subtask. */
export function handoffPrompt(handoff: Handoff): string {
  return [
    "",
    `TAKEOVER. You are replacing ${handoff.predecessor.agentId}, which ${handoff.reason.kind === "operator_kill" ? "was killed by the operator" : handoff.reason.kind}: ${handoff.reason.detail}`,
    "Continue the SAME subtask and write the SAME output key with the SAME schema. Do not restart the investigation.",
    `Already done and available in inputs.handoff: ${describeRecovered(handoff)}. Identical tool calls return instantly from the run cache; do not redo work that is already recorded.`,
    handoff.partialNotes ? `The previous agent's last notes: ${handoff.partialNotes}` : "",
    handoff.criticFindings
      ? `The critic rejected the previous output: ${JSON.stringify(handoff.criticFindings)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
