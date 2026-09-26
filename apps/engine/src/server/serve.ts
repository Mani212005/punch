import { createEngineServer } from "./server.js";

export interface ServeOptions {
  port?: number;
  host?: string;
  pairingToken?: string;
  viewerToken?: string;
  webOrigins?: string[];
  runsDir?: string;
  sessionsDir?: string;
  config?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  pairingToken: string;
  viewerToken: string;
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
  return {
    url,
    pairingToken: server.tokens.pairingToken,
    viewerToken: server.tokens.viewerToken,
    close: () => server.close(),
  };
}
