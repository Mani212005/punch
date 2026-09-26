import { createEngineServer } from "./server.js";
import { buildViewerUrl, startQuickTunnel } from "./tunnel.js";

export interface ServeOptions {
  port?: number;
  host?: string;
  pairingToken?: string;
  viewerToken?: string;
  webOrigins?: string[];
  runsDir?: string;
  sessionsDir?: string;
  config?: string;
  tunnel?: boolean;
  /** Override the cloudflared binary (tests use a missing path to prove the error path). */
  tunnelBinary?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  pairingToken: string;
  viewerToken: string;
  tunnelUrl?: string;
  viewerUrl?: string;
  close: () => Promise<void>;
}

/**
 * `punch serve`: bind localhost, print the pairing token (control routes)
 * and the viewer token (read-only `/runs/:id/events` and `/runs/:id/trace`),
 * then serve until SIGINT.
 */
export async function serveCommand(options: ServeOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const server = createEngineServer({
    runsDir: options.runsDir ?? "runs",
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
    ...(options.config ? { configPath: options.config } : {}),
    ...(options.pairingToken ? { pairingToken: options.pairingToken } : {}),
    ...(options.viewerToken ? { viewerToken: options.viewerToken } : {}),
    ...(options.webOrigins ? { webOrigins: options.webOrigins } : {}),
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4141;
  const url = await server.listen(port, host);
  log(`punch engine listening on ${url}`);
  log(`pairing token: ${server.tokens.pairingToken}`);
  log(`viewer token: ${server.tokens.viewerToken}`);
  log(`web origins: ${(options.webOrigins ?? []).join(", ") || "(none)"}`);

  let tunnelUrl: string | undefined;
  let viewerUrl: string | undefined;
  let stopTunnel: (() => Promise<void>) | undefined;
  if (options.tunnel) {
    let handle;
    try {
      handle = await startQuickTunnel({
        localUrl: url,
        ...(options.tunnelBinary ? { binary: options.tunnelBinary } : {}),
        log,
      });
    } catch (err) {
      // Do not leave a half-started engine listening: --tunnel callers expect
      // a non-zero exit with install guidance, not a tunnel-less server.
      await server.close();
      throw err;
    }
    tunnelUrl = handle.publicUrl;
    viewerUrl = buildViewerUrl(handle.publicUrl, server.tokens.viewerToken);
    stopTunnel = () => handle.stop();
    log(`tunnel: ${tunnelUrl}`);
    log(`viewer URL (read-only, paste into the Punch Watch page): ${viewerUrl}`);
    log(
      `control routes stay unreachable with the viewer token: kill, approve, and stop require the pairing token.`,
    );
  }
  return {
    url,
    pairingToken: server.tokens.pairingToken,
    viewerToken: server.tokens.viewerToken,
    ...(tunnelUrl ? { tunnelUrl } : {}),
    ...(viewerUrl ? { viewerUrl } : {}),
    close: async () => {
      if (stopTunnel) await stopTunnel();
      await server.close();
    },
  };
}
