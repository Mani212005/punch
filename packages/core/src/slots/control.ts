import * as fs from "node:fs";
import * as path from "node:path";
import type { SlotRole } from "@punch/shared";

/**
 * How `punch kill <runId> <slot>` reaches a run in another process: a small request file in
 * `<runsDir>/<runId>/control/`. The run polls the directory, consumes each request once, and
 * kills the slot's running agent. The HTTP API (C1) calls `RunHandle.kill` directly instead.
 */
export interface KillRequest {
  role: SlotRole;
  detail?: string;
  requestedAt: number;
}

export function controlDir(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, "control");
}

export function requestKill(
  runsDir: string,
  runId: string,
  role: SlotRole,
  detail?: string,
): string {
  const dir = controlDir(runsDir, runId);
  if (!fs.existsSync(path.join(runsDir, runId))) {
    throw new Error(`no run ${runId} under ${runsDir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const request: KillRequest = {
    role,
    ...(detail ? { detail } : {}),
    requestedAt: Date.now(),
  };
  const name = `kill-${request.requestedAt}-${role}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(request));
  fs.renameSync(tmp, path.join(dir, name));
  return path.join(dir, name);
}

/** Polls for kill requests; returns a stop function. Each request file is deleted once handled. */
export function watchKillRequests(
  runsDir: string,
  runId: string,
  onKill: (request: KillRequest) => void,
  intervalMs = 200,
): () => void {
  const dir = controlDir(runsDir, runId);
  const tick = (): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith("kill-") && n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const file = path.join(dir, name);
      try {
        const request = JSON.parse(fs.readFileSync(file, "utf-8")) as KillRequest;
        fs.rmSync(file, { force: true });
        onKill(request);
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
