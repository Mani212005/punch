import type { SlotRole } from "@punch/shared";
import { HttpError } from "./http.js";

export type ToolChaosMode = "500" | "hang" | "truncate" | "empty";

export type ChaosProfile =
  | { kind: "provider-down"; providerId: string }
  | { kind: "stall"; role: SlotRole }
  | { kind: "garbage"; role: SlotRole }
  | { kind: "kill-after"; role: SlotRole; turns: number }
  | { kind: "tool"; tool: string; mode: ToolChaosMode };

export interface ChaosConfig {
  /** Raw profile strings */
  raw: string[];
  /** Parsed profiles list */
  profiles: ChaosProfile[];
  /** Providers marked as down */
  providerDown: Set<string>;
  /** Roles that should stall */
  stallRoles: Set<SlotRole>;
  /** Roles that should return garbage output */
  garbageRoles: Set<SlotRole>;
  /** Turn limit per role before simulated crash */
  killAfterRoles: Map<SlotRole, number>;
  /** Per-tool chaos configuration (tool name -> chaos mode) */
  toolChaos: Map<string, ToolChaosMode>;
}

const VALID_SLOT_ROLES = new Set<SlotRole>(["planner", "researcher", "executor", "critic"]);

/**
 * Parses raw chaos profile strings (from CLI or config, e.g. ["provider-down:anthropic", "stall:researcher"])
 * into a structured ChaosConfig object.
 */
export function parseChaosProfile(input?: string[] | string | null): ChaosConfig {
  const rawList: string[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string" && item.trim().length > 0) {
        rawList.push(
          ...item
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
    }
  } else if (typeof input === "string" && input.trim().length > 0) {
    rawList.push(
      ...input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const profiles: ChaosProfile[] = [];
  const providerDown = new Set<string>();
  const stallRoles = new Set<SlotRole>();
  const garbageRoles = new Set<SlotRole>();
  const killAfterRoles = new Map<SlotRole, number>();
  const toolChaos = new Map<string, ToolChaosMode>();

  for (const raw of rawList) {
    const parts = raw.split(":");
    const kind = parts[0]?.trim();

    if (!kind) continue;

    if (kind === "provider-down" && parts[1]) {
      const providerId = parts[1].trim();
      providerDown.add(providerId);
      profiles.push({ kind: "provider-down", providerId });
    } else if (kind === "stall" && parts[1]) {
      const role = parts[1].trim() as SlotRole;
      if (VALID_SLOT_ROLES.has(role)) {
        stallRoles.add(role);
        profiles.push({ kind: "stall", role });
      }
    } else if (kind === "garbage" && parts[1]) {
      const role = parts[1].trim() as SlotRole;
      if (VALID_SLOT_ROLES.has(role)) {
        garbageRoles.add(role);
        profiles.push({ kind: "garbage", role });
      }
    } else if (kind === "kill-after" && parts[1] && parts[2]) {
      const role = parts[1].trim() as SlotRole;
      const turns = parseInt(parts[2].trim(), 10);
      if (VALID_SLOT_ROLES.has(role) && !Number.isNaN(turns) && turns >= 0) {
        killAfterRoles.set(role, turns);
        profiles.push({ kind: "kill-after", role, turns });
      }
    } else if (kind === "tool" && parts[1] && parts[2]) {
      const tool = parts[1].trim();
      const mode = parts[2].trim() as ToolChaosMode;
      if (mode === "500" || mode === "hang" || mode === "truncate" || mode === "empty") {
        toolChaos.set(tool, mode);
        profiles.push({ kind: "tool", tool, mode });
      }
    } else if (kind.startsWith("tool-") && parts[1]) {
      // Shorthand e.g. "tool-500:github_get_contents" or "tool-hang:osv_query"
      const mode = kind.replace("tool-", "") as ToolChaosMode;
      const tool = parts[1].trim();
      if (mode === "500" || mode === "hang" || mode === "truncate" || mode === "empty") {
        toolChaos.set(tool, mode);
        profiles.push({ kind: "tool", tool, mode });
      }
    }
  }

  return {
    raw: rawList,
    profiles,
    providerDown,
    stallRoles,
    garbageRoles,
    killAfterRoles,
    toolChaos,
  };
}

/**
 * Applies tool-level chaos if configured for the given tool.
 * - 500: throws an HttpError with 500 status (classified as transient)
 * - hang: hangs until aborted or timeout
 * - truncate: returns truncated string / object representation
 * - empty: returns empty object / empty array
 */
export async function applyToolChaos(
  toolName: string,
  chaos?: ChaosConfig | Map<string, ToolChaosMode> | ToolChaosMode,
  signal?: AbortSignal,
): Promise<{ intercepted: boolean; output?: unknown }> {
  let mode: ToolChaosMode | undefined;

  if (typeof chaos === "string") {
    mode = chaos;
  } else if (chaos instanceof Map) {
    mode = chaos.get(toolName);
  } else if (chaos && "toolChaos" in chaos) {
    mode = chaos.toolChaos.get(toolName);
  }

  if (!mode) {
    return { intercepted: false };
  }

  if (mode === "500") {
    throw new HttpError({
      message: `Chaos injected 500 Internal Server Error for tool '${toolName}'`,
      url: `chaos://${toolName}`,
      status: 500,
      errorClass: "transient",
      retries: 0,
    });
  }

  if (mode === "hang") {
    // Hang until signal aborts
    await new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted during chaos hang"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason ?? new Error("Aborted during chaos hang"));
        },
        { once: true },
      );
    });
    return { intercepted: true };
  }

  if (mode === "truncate") {
    return {
      intercepted: true,
      output: { __truncated: true, partial: '{"status": "err', raw: "corrupted_chaos_payload" },
    };
  }

  if (mode === "empty") {
    return {
      intercepted: true,
      output: {},
    };
  }

  return { intercepted: false };
}
