/**
 * Shared types and the {@link HueError} class for the Hue Bridge layer.
 *
 * The Hue v1 REST API is intentionally used over v2: it is simpler, requires
 * no HTTPS handshake, and is sufficient for on/off control of smart sockets.
 * v2 may be revisited if/when v1 is removed from new bridges.
 */

/**
 * The kinds of failure the Hue layer can surface to callers. Each kind maps
 * to a different recovery path:
 *
 * - `timeout`         — the request did not complete within the timeout. Retry-safe.
 * - `network`         — TCP/DNS-level failure. Retry-safe.
 * - `http`            — bridge returned a non-2xx status. Not retry-safe.
 * - `protocol`        — bridge responded but the body was malformed. Not retry-safe.
 * - `unauthorized`    — API key was rejected (Hue error code 1). User must re-pair.
 * - `link-not-pressed`— pairing request received before the user pressed the link button (code 101).
 */
export type HueErrorKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'protocol'
  | 'unauthorized'
  | 'link-not-pressed';

export class HueError extends Error {
  public readonly kind: HueErrorKind;
  public readonly httpStatus?: number;
  public readonly cause?: unknown;

  public constructor(
    message: string,
    kind: HueErrorKind,
    extras: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'HueError';
    this.kind = kind;
    if (extras.httpStatus !== undefined) {
      this.httpStatus = extras.httpStatus;
    }
    if (extras.cause !== undefined) {
      this.cause = extras.cause;
    }
  }
}

/** A Hue Bridge found via mDNS or cloud discovery. */
export interface BridgeCandidate {
  /** Bridge ID as advertised by Hue (`bridgeid` TXT record or `/api/config`). Uppercase hex. */
  id: string;
  /** IPv4 address on the local network. */
  ip: string;
  /** Human-readable bridge name when known. */
  name?: string;
  /** Source that produced this candidate — useful for logging and UI hints. */
  source: 'mdns' | 'cloud' | 'manual';
}

/**
 * A Hue light/socket as returned by `GET /api/<key>/lights`, flattened from
 * the Hue map-of-id-to-light response into a simple list.
 */
export interface HueLight {
  /** Numeric id as a string (Hue uses string keys in the lights map). */
  id: string;
  /** User-chosen name in the Hue app. */
  name: string;
  /** Hue device type, e.g. `"On/Off plug-in unit"`. */
  type: string;
  /** Internal model id, e.g. `"LOM001"` for Hue smart plug. */
  modelid: string;
  /** Manufacturer string from Hue, e.g. `"Signify Netherlands B.V."`. */
  manufacturername: string;
  /** Whether the bridge can currently reach the device. */
  reachable: boolean;
  /** Current on/off state. */
  on: boolean;
}

/** Minimal bridge metadata from `GET /api/config` (no auth required). */
export interface BridgeConfig {
  name: string;
  bridgeid: string;
  modelid: string;
  apiversion: string;
  swversion: string;
}
