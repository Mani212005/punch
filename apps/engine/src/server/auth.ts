import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** A pairing or viewer token: 256 bits rendered as base64url. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The bearer credential for a request: the `Authorization: Bearer <token>`
 * header first, then the `?token=` query parameter (EventSource clients and
 * tunnels cannot always set headers).
 */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const query = url.searchParams.get("token");
  if (query) return query;
  return null;
}

export interface ServerTokens {
  pairingToken: string;
  viewerToken: string;
}

export type AuthScope = "control" | "viewer";

/**
 * Control routes need the pairing token. The two read-only viewer routes
 * (`GET /runs/:id/events`, `GET /runs/:id/trace`) accept the pairing token
 * or the viewer token; the viewer token grants nothing else.
 */
export function authorize(token: string | null, tokens: ServerTokens, scope: AuthScope): boolean {
  if (token === null) return false;
  if (safeEqual(token, tokens.pairingToken)) return true;
  if (scope === "viewer" && safeEqual(token, tokens.viewerToken)) return true;
  return false;
}
