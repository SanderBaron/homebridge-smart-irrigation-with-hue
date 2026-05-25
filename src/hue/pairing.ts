import os from 'node:os';

import { HueError } from './types';

export interface PairingOptions {
  /** Bridge IPv4 address. */
  ip: string;
  /**
   * `devicetype` value sent to the bridge. Hue limits the total to 40 characters
   * formatted as `<app>#<device>`. When omitted, defaults to
   * `smartirrigation#<truncated-hostname>` so the bridge's whitelist entry is
   * recognisable per host.
   */
  deviceType?: string;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface HueApiSuccessEntry {
  success: { username: string };
}

interface HueApiErrorEntry {
  error: { type: number; address: string; description: string };
}

type HueApiResponse = Array<HueApiSuccessEntry | HueApiErrorEntry>;

const APP_NAME = 'smartirrigation';
const MAX_DEVICE_TYPE_LENGTH = 40;
const LINK_BUTTON_NOT_PRESSED = 101;

/**
 * Build the default `devicetype` for pairing requests.
 *
 * Format: `smartirrigation#<hostname>`, total length clamped to 40 characters
 * per Hue's API constraint.
 */
export function defaultDeviceType(hostname: string = os.hostname()): string {
  const sanitisedHost = hostname.split('.')[0] ?? 'host';
  const prefix = `${APP_NAME}#`;
  const remaining = MAX_DEVICE_TYPE_LENGTH - prefix.length;
  return prefix + sanitisedHost.slice(0, remaining);
}

/**
 * Attempt a single pairing request against a Hue Bridge.
 *
 * One attempt only — the caller (typically the custom UI server) is responsible
 * for polling at a sensible interval while showing a "press the button" prompt
 * to the user. The function throws {@link HueError} with kind `link-not-pressed`
 * when the bridge reports that the link button has not yet been pressed, so
 * callers can distinguish "keep trying" from "give up".
 *
 * @returns the Hue API key (username) the bridge issued.
 */
export async function pairWithBridge(options: PairingOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deviceType = options.deviceType ?? defaultDeviceType();
  const url = `http://${options.ip}/api`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devicetype: deviceType }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HueError(`Pairing request to ${options.ip} timed out`, 'timeout', { cause: err });
    }
    throw new HueError(`Network error contacting Hue Bridge at ${options.ip}`, 'network', {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new HueError(
      `Hue Bridge at ${options.ip} returned HTTP ${res.status} during pairing`,
      'http',
      { httpStatus: res.status },
    );
  }

  let body: HueApiResponse;
  try {
    body = (await res.json()) as HueApiResponse;
  } catch (err) {
    throw new HueError('Pairing response was not valid JSON', 'protocol', { cause: err });
  }

  if (!Array.isArray(body) || body.length === 0) {
    throw new HueError('Pairing response was empty or malformed', 'protocol');
  }

  const first = body[0];
  if (first === undefined) {
    throw new HueError('Pairing response was empty', 'protocol');
  }

  if ('success' in first && typeof first.success.username === 'string') {
    return first.success.username;
  }

  if ('error' in first) {
    if (first.error.type === LINK_BUTTON_NOT_PRESSED) {
      throw new HueError(
        'Link button on the Hue Bridge has not been pressed yet',
        'link-not-pressed',
      );
    }
    throw new HueError(`Hue Bridge rejected pairing: ${first.error.description}`, 'protocol');
  }

  throw new HueError('Pairing response was in an unrecognised shape', 'protocol');
}
