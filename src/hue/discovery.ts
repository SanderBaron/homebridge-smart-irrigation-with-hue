import { Bonjour } from 'bonjour-service';
import type { Logging } from 'homebridge';

import type { BridgeCandidate } from './types';

/**
 * The subset of bonjour-service's `Service` object that the discovery code
 * reads. Defined locally so the function can be unit-tested without depending
 * on bonjour-service's class hierarchy.
 */
export interface MdnsService {
  addresses?: string[];
  name?: string;
  host?: string;
  fqdn?: string;
  txt?: Record<string, string | undefined>;
}

/**
 * Minimal Bonjour surface area the discovery code depends on. Defined so unit
 * tests can pass a fake without instantiating a real mDNS socket.
 */
export interface BonjourLike {
  find(opts: { type: string }): BonjourBrowserLike;
  destroy(): void;
}

export interface BonjourBrowserLike {
  on(event: 'up', listener: (service: MdnsService) => void): unknown;
  stop(): void;
}

export interface DiscoveryOptions {
  /** Maximum time (ms) to wait for mDNS responses. Default 5000. */
  timeoutMs?: number;
  /** When mDNS finds nothing, fall back to the Hue cloud discovery endpoint. Default true. */
  cloudFallback?: boolean;
  /** Optional Homebridge logger for debug breadcrumbs. */
  log?: Logging;
  /** Injectable Bonjour instance — tests pass a fake; in production omit to use a real socket. */
  bonjour?: BonjourLike;
  /** Injectable fetch — tests pass a stub; in production omit to use global fetch. */
  fetchImpl?: typeof fetch;
}

const CLOUD_DISCOVERY_URL = 'https://discovery.meethue.com/';
const CLOUD_DISCOVERY_TIMEOUT_MS = 5000;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Discover Hue Bridges on the local network.
 *
 * Strategy:
 * 1. Browse mDNS for `_hue._tcp` services for `timeoutMs`.
 * 2. If nothing turns up and `cloudFallback` is enabled, query Philips' public
 *    discovery endpoint as a backup. The cloud endpoint returns bridges seen
 *    on the same public IP, so it is a useful fallback when mDNS is blocked
 *    by VLAN/firewall configuration.
 * 3. Always return a deduplicated list (by bridge id).
 *
 * Never throws — failure paths return an empty array and log at debug level.
 */
export async function discoverBridges(options: DiscoveryOptions = {}): Promise<BridgeCandidate[]> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const cloudFallback = options.cloudFallback ?? true;
  const log = options.log;

  const candidates = new Map<string, BridgeCandidate>();

  const bonjour = options.bonjour ?? (new Bonjour() as unknown as BonjourLike);
  try {
    await collectMdnsCandidates(bonjour, timeoutMs, candidates, log);
  } catch (err) {
    log?.debug('mDNS discovery failed: %s', String(err));
  } finally {
    try {
      bonjour.destroy();
    } catch (err) {
      log?.debug('Failed to destroy bonjour instance: %s', String(err));
    }
  }

  if (candidates.size === 0 && cloudFallback) {
    const cloud = await discoverViaCloud(options.fetchImpl ?? fetch, log);
    for (const c of cloud) {
      if (!candidates.has(c.id)) {
        candidates.set(c.id, c);
      }
    }
  }

  return [...candidates.values()];
}

async function collectMdnsCandidates(
  bonjour: BonjourLike,
  timeoutMs: number,
  out: Map<string, BridgeCandidate>,
  log?: Logging,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const browser = bonjour.find({ type: 'hue' });
    browser.on('up', (service: MdnsService) => {
      const candidate = parseMdnsService(service);
      if (candidate && !out.has(candidate.id)) {
        log?.debug('mDNS discovered Hue Bridge %s at %s', candidate.id, candidate.ip);
        out.set(candidate.id, candidate);
      }
    });
    setTimeout(() => {
      browser.stop();
      resolve();
    }, timeoutMs);
  });
}

function parseMdnsService(service: MdnsService): BridgeCandidate | null {
  const ip = (service.addresses ?? []).find((a: string) => IPV4_PATTERN.test(a));
  if (ip === undefined) {
    return null;
  }
  const txt = service.txt ?? {};
  const rawId = txt['bridgeid'] ?? service.host ?? service.fqdn ?? ip;
  return {
    id: rawId.toUpperCase(),
    ip,
    ...(service.name !== undefined ? { name: service.name } : {}),
    source: 'mdns',
  };
}

async function discoverViaCloud(
  fetchImpl: typeof fetch,
  log?: Logging,
): Promise<BridgeCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(CLOUD_DISCOVERY_URL, { signal: controller.signal });
    if (!res.ok) {
      log?.debug('Cloud discovery returned HTTP %d', res.status);
      return [];
    }
    const body = (await res.json()) as Array<{ id?: string; internalipaddress?: string }>;
    if (!Array.isArray(body)) {
      return [];
    }
    return body
      .filter(
        (b): b is { id: string; internalipaddress: string } =>
          typeof b.id === 'string' &&
          typeof b.internalipaddress === 'string' &&
          IPV4_PATTERN.test(b.internalipaddress),
      )
      .map((b) => ({
        id: b.id.toUpperCase(),
        ip: b.internalipaddress,
        source: 'cloud' as const,
      }));
  } catch (err) {
    log?.debug('Cloud discovery failed: %s', String(err));
    return [];
  } finally {
    clearTimeout(timer);
  }
}
