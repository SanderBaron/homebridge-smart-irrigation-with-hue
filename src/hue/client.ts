import type { Logging } from 'homebridge';

import { HueError, type BridgeConfig, type HueLight } from './types';

export interface HueClientOptions {
  /** Bridge IPv4 address (e.g. `192.0.2.1`). */
  ip: string;
  /** API key (username) issued by the bridge during pairing. */
  apiKey: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Number of retries on transient failures (timeout, network, 5xx). Default 1. */
  retries?: number;
  /** Backoff (ms) between retries — multiplied by attempt number. Default 100. */
  backoffMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional Homebridge logger. */
  log?: Logging;
}

type HttpMethod = 'GET' | 'PUT' | 'POST';

interface HueApiErrorEntry {
  error: { type: number; address: string; description: string };
}

interface HueLightApi {
  name: string;
  type: string;
  modelid: string;
  manufacturername: string;
  state: { on: boolean; reachable?: boolean };
}

const HUE_UNAUTHORIZED = 1;

/**
 * Thin wrapper around the Hue Bridge v1 REST API covering only the endpoints
 * this plugin needs: bridge metadata, light listing, and on/off control.
 *
 * Each public method:
 * - applies the configured per-request timeout via AbortController;
 * - retries transient failures (timeout, network, 5xx) up to `retries` times;
 * - converts Hue's application-level error envelopes into typed {@link HueError}s.
 *
 * Construct one instance per bridge — the client is stateless beyond config.
 */
export class HueClient {
  private readonly ip: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logging | undefined;

  public constructor(options: HueClientOptions) {
    this.ip = options.ip;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retries = options.retries ?? 1;
    this.backoffMs = options.backoffMs ?? 100;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
  }

  /** Fetch unauthenticated bridge metadata. Useful as a reachability probe. */
  public async getConfig(): Promise<BridgeConfig> {
    return this.request<BridgeConfig>('GET', '/api/config');
  }

  /** List every light/socket the bridge knows about. */
  public async getLights(): Promise<HueLight[]> {
    const raw = await this.request<Record<string, HueLightApi>>(
      'GET',
      `/api/${this.apiKey}/lights`,
    );
    return Object.entries(raw).map(([id, light]) => mapLight(id, light));
  }

  /** Fetch a single light by id. */
  public async getLight(id: string): Promise<HueLight> {
    const raw = await this.request<HueLightApi>(
      'GET',
      `/api/${this.apiKey}/lights/${encodeURIComponent(id)}`,
    );
    return mapLight(id, raw);
  }

  /** Turn a Hue socket/light on or off. */
  public async setLightOn(id: string, on: boolean): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/api/${this.apiKey}/lights/${encodeURIComponent(id)}/state`,
      { on },
    );
  }

  /** Returns true when the bridge responds to an unauthenticated config probe. */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.getConfig();
      return true;
    } catch (err) {
      this.log?.debug('Hue health check failed: %s', String(err));
      return false;
    }
  }

  private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.attemptRequest<T>(method, path, body);
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === this.retries) {
          throw err;
        }
        const wait = this.backoffMs * (attempt + 1);
        this.log?.debug(
          'Hue %s %s failed (%s); retrying in %dms',
          method,
          path,
          (err as Error).message,
          wait,
        );
        await delay(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new HueError('Unknown error', 'network');
  }

  private async attemptRequest<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `http://${this.ip}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const init: RequestInit = { method, signal: controller.signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HueError(`Hue request to ${url} timed out`, 'timeout', { cause: err });
      }
      throw new HueError(`Network error contacting Hue Bridge at ${this.ip}`, 'network', {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new HueError(`Hue Bridge returned HTTP ${res.status}`, 'http', {
        httpStatus: res.status,
      });
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new HueError('Hue Bridge response was not valid JSON', 'protocol', { cause: err });
    }

    // Hue returns array-wrapped error envelopes for failed mutations: detect them
    // before returning, so callers see a typed HueError instead of garbage data.
    if (Array.isArray(parsed)) {
      const entries: unknown[] = parsed;
      const firstError = entries.find(
        (entry): entry is HueApiErrorEntry =>
          typeof entry === 'object' && entry !== null && 'error' in entry,
      );
      if (firstError !== undefined) {
        if (firstError.error.type === HUE_UNAUTHORIZED) {
          throw new HueError(
            'Hue Bridge rejected the API key — re-pairing required',
            'unauthorized',
          );
        }
        throw new HueError(`Hue API error: ${firstError.error.description}`, 'protocol');
      }
    }

    return parsed as T;
  }

  private isRetryable(err: unknown): boolean {
    if (!(err instanceof HueError)) {
      return false;
    }
    if (err.kind === 'timeout' || err.kind === 'network') {
      return true;
    }
    if (err.kind === 'http' && err.httpStatus !== undefined && err.httpStatus >= 500) {
      return true;
    }
    return false;
  }
}

function mapLight(id: string, light: HueLightApi): HueLight {
  return {
    id,
    name: light.name,
    type: light.type,
    modelid: light.modelid,
    manufacturername: light.manufacturername,
    reachable: light.state.reachable ?? true,
    on: light.state.on,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
