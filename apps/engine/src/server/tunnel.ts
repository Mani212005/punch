import { spawn, type ChildProcess } from "node:child_process";

export const CLOUDFLARED_INSTALL_GUIDANCE =
  "cloudflared is required for `punch serve --tunnel` but was not found on PATH. " +
  "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ " +
  "(macOS: `brew install cloudflare/cloudflare/cloudflared`), then re-run `punch serve --tunnel`.";

export const TUNNEL_URL_PATTERN = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i;

export interface TunnelHandle {
  publicUrl: string;
  stop: () => Promise<void>;
}

export interface StartTunnelOptions {
  /** Local engine URL the tunnel should point at, e.g. http://127.0.0.1:4141. */
  localUrl: string;
  /** Binary name or path for cloudflared. Defaults to `cloudflared` on PATH. */
  binary?: string;
  /** Milliseconds to wait for cloudflared to print the public URL. Default 30_000. */
  timeoutMs?: number;
  log?: (line: string) => void;
  spawnFn?: typeof spawn;
}

/**
 * Start a `cloudflared` quick tunnel (no account, no config) pointing at the
 * local engine. Resolves once cloudflared prints the public
 * `https://*.trycloudflare.com` URL. Rejects with install guidance when the
 * binary is missing, and with the captured stderr tail on any other failure.
 */
export function startQuickTunnel(options: StartTunnelOptions): Promise<TunnelHandle> {
  const { localUrl, binary = "cloudflared", timeoutMs = 30_000, log } = options;
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(binary, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new Error(
          `${CLOUDFLARED_INSTALL_GUIDANCE} (spawn failed: ${err instanceof Error ? err.message : String(err)})`,
        ),
      );
      return;
    }

    let settled = false;
    const output: string[] = [];
    const finish = (err: Error | null, handle: TunnelHandle | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err || !handle) {
        try {
          child.kill();
        } catch {
          // Already exited.
        }
        reject(err ?? new Error("cloudflared tunnel failed to start"));
        return;
      }
      resolve(handle);
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for cloudflared to print a tunnel URL for ${localUrl}. ` +
            `Last output: ${output.slice(-5).join(" | ") || "(none)"}`,
        ),
        null,
      );
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk: unknown): void => {
      const text = String(chunk);
      output.push(text);
      if (output.length > 50) output.shift();
      log?.(text.trimEnd());
      const match = TUNNEL_URL_PATTERN.exec(text);
      if (match) {
        const publicUrl = match[0];
        finish(null, {
          publicUrl,
          stop: () =>
            new Promise<void>((stopResolve) => {
              child.once("exit", () => stopResolve());
              try {
                child.kill();
              } catch {
                stopResolve();
                return;
              }
              setTimeout(() => stopResolve(), 2000).unref?.();
            }),
        });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        finish(new Error(CLOUDFLARED_INSTALL_GUIDANCE), null);
        return;
      }
      finish(
        new Error(
          `cloudflared tunnel failed: ${err.message}. Last output: ${output.slice(-5).join(" | ") || "(none)"}`,
        ),
        null,
      );
    });
    child.once("exit", (code) => {
      if (!settled) {
        finish(
          new Error(
            `cloudflared exited with code ${code ?? "unknown"} before printing a tunnel URL. ` +
              `Last output: ${output.slice(-5).join(" | ") || "(none)"}`,
          ),
          null,
        );
      }
    });
  });
}

/**
 * Viewer URL printed by `punch serve --tunnel`: the public tunnel base plus
 * only the viewer token. Paste it into the Watch page; it never carries the
 * pairing (control) token.
 */
export function buildViewerUrl(publicUrl: string, viewerToken: string): string {
  return `${publicUrl.replace(/\/$/, "")}/?token=${encodeURIComponent(viewerToken)}`;
}

/** Direct SSE URL for one run through the tunnel (viewer token only). */
export function buildViewerEventsUrl(
  publicUrl: string,
  runId: string,
  viewerToken: string,
): string {
  return `${publicUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}/events?token=${encodeURIComponent(viewerToken)}`;
}

/** Direct trace URL for one run through the tunnel (viewer token only). */
export function buildViewerTraceUrl(publicUrl: string, runId: string, viewerToken: string): string {
  return `${publicUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}/trace?token=${encodeURIComponent(viewerToken)}`;
}

export interface ParsedViewerUrl {
  /** Engine/tunnel base, e.g. https://abc.trycloudflare.com */
  engineBase: string;
  /** Run id when the URL names one, else null. */
  runId: string | null;
  /** Viewer token from `?token=`, else null. */
  token: string | null;
}

/**
 * Parse anything the Watch page's viewer-URL input accepts: a base viewer
 * URL from `buildViewerUrl`, a per-run events/trace URL, or a bare base URL.
 * Never throws: unparseable input yields empty fields the UI reports.
 */
export function parseViewerUrl(input: string): ParsedViewerUrl {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const token = url.searchParams.get("token");
    const runMatch = /\/runs\/([^/]+)\/(events|trace)\/?$/.exec(url.pathname);
    const engineBase = `${url.protocol}//${url.host}`;
    return {
      engineBase,
      runId: runMatch?.[1] ? decodeURIComponent(runMatch[1]) : null,
      token,
    };
  } catch {
    return { engineBase: "", runId: null, token: null };
  }
}
