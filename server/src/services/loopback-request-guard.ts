import type { NextFunction, Request, Response } from 'express';
import { configuredLanHostnames } from './lan-access.js';

/**
 * The API listens on 127.0.0.1 only, but binding alone does not stop DNS rebinding: a page on
 * attacker.example can re-resolve its own name to 127.0.0.1 and then talk to this API as a
 * same-origin client. The browser still sends the attacker's name in `Host` and `Origin`, so only
 * loopback names are accepted there. This mirrors the realtime gateway's origin policy.
 */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Loopback names plus the explicitly configured LAN hosts (see lan-access.ts). */
function allowedHostnames(): Set<string> {
  return new Set([...LOOPBACK_HOSTNAMES, ...configuredLanHostnames()]);
}

export type LoopbackRejection = 'host_missing' | 'host_not_loopback' | 'origin_not_loopback';

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return allowedHostnames().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && allowedHostnames().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function loopbackRequestRejection(host: string | undefined, origin: string | undefined): LoopbackRejection | undefined {
  if (!host) return 'host_missing';
  if (!isLoopbackHostHeader(host)) return 'host_not_loopback';
  if (origin !== undefined && !isLoopbackOrigin(origin)) return 'origin_not_loopback';
  return undefined;
}

export function loopbackRequestGuard() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const rejection = loopbackRequestRejection(request.headers.host, request.headers.origin);
    if (!rejection) {
      next();
      return;
    }
    const detail = 'Die lokale API akzeptiert nur Anfragen an localhost, 127.0.0.1 oder [::1].';
    response.status(403).json({
      type: 'urn:job-match-and-apply:error:authentication', title: 'Operation fehlgeschlagen', status: 403,
      category: 'authentication', detail, error: detail, errorCode: rejection, instance: request.path,
    });
  };
}
