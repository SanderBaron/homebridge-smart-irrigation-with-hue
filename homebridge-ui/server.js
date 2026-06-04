/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

/**
 * Custom Homebridge UI server.
 *
 * Runs in the Homebridge UI process (separate from the plugin platform itself)
 * and exposes endpoints the browser-side script calls via
 * `homebridge.request(path, payload)`. We delegate to the compiled plugin
 * modules in `../dist/` rather than re-implementing the Hue logic here.
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

const { discoverBridges } = require('../dist/hue/discovery');
const { pairWithBridge } = require('../dist/hue/pairing');
const { HueClient } = require('../dist/hue/client');
const { fetchOpenMeteo } = require('../dist/weather/openMeteo');
const { fetchBuienradar } = require('../dist/weather/buienradar');
const { fetchOpenWeatherMap } = require('../dist/weather/openWeatherMap');
const { evaluateRainBlocking, evaluateZoneBlocking } = require('../dist/blockingEngine');
const { parseConfig } = require('../dist/config');

/** Map wind bearing to the nearest compass octant string. */
function degToOctant(deg) {
  const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return OCTANTS[idx];
}

class SmartIrrigationUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/discover-bridges', (payload) => this.discover(payload));
    this.onRequest('/pair-bridge', (payload) => this.pair(payload));
    this.onRequest('/list-lights', (payload) => this.listLights(payload));
    this.onRequest('/probe-bridge', (payload) => this.probe(payload));
    this.onRequest('/weather-status', (payload) => this.weatherStatus(payload));

    this.ready();
  }

  /**
   * mDNS + cloud discovery. Returns `[{ id, ip, name?, source }]`. Always
   * resolves — empty array means nothing found.
   */
  async discover(payload) {
    const timeoutMs = Number(payload && payload.timeoutMs) || 5000;
    try {
      return await discoverBridges({ timeoutMs });
    } catch (err) {
      throw new RequestError('Discovery failed: ' + String(err && err.message ? err.message : err));
    }
  }

  /**
   * Single pairing attempt. Returns `{ ok: true, apiKey }` on success, or
   * `{ ok: false, kind: 'link-not-pressed' }` so the UI can poll. Other
   * errors throw a RequestError.
   */
  async pair(payload) {
    if (!payload || typeof payload.ip !== 'string' || payload.ip.length === 0) {
      throw new RequestError('Pairing requires a bridge ip');
    }
    try {
      const apiKey = await pairWithBridge({ ip: payload.ip });
      return { ok: true, apiKey };
    } catch (err) {
      if (err && err.kind === 'link-not-pressed') {
        return { ok: false, kind: 'link-not-pressed' };
      }
      const kind = (err && err.kind) || 'unknown';
      const message = err && err.message ? err.message : String(err);
      throw new RequestError(`Pairing failed (${kind}): ${message}`);
    }
  }

  /**
   * List Hue lights/sockets so the zone and pump dropdowns can populate.
   * The UI calls this once paired.
   */
  async listLights(payload) {
    if (!payload || typeof payload.ip !== 'string' || typeof payload.apiKey !== 'string') {
      throw new RequestError('list-lights requires ip and apiKey');
    }
    const client = new HueClient({
      ip: payload.ip,
      apiKey: payload.apiKey,
      timeoutMs: Number(payload.timeoutMs) || 5000,
      retries: 0,
    });
    try {
      return await client.getLights();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw new RequestError(`Could not list lights: ${message}`);
    }
  }

  /**
   * Fetch live weather data from all configured sources and evaluate the
   * current rain-block and per-zone wind-block decisions. Called by the
   * status dashboard at the top of the settings UI; it auto-refreshes every
   * 15 minutes so the user can see whether conditions match reality.
   */
  async weatherStatus(payload) {
    // The client passes its current config object as the payload so the server
    // doesn't need filesystem access to know which sources / thresholds to use.
    let cfg;
    try {
      const raw = (payload && typeof payload === 'object') ? payload : {};
      const result = parseConfig({ platform: 'SmartIrrigation', ...raw });
      if (!result.ok) {
        throw new Error('Config invalid: ' + result.error);
      }
      cfg = result.config;
    } catch (err) {
      throw new RequestError('Could not parse config: ' + String(err && err.message ? err.message : err));
    }

    const { latitude, longitude } = cfg.location;

    // Build fetch tasks for each configured source.
    const fetchers = [];
    if (cfg.weather.sources.includes('open-meteo')) {
      fetchers.push({ key: 'open-meteo', label: 'Open-Meteo', p: fetchOpenMeteo({ latitude, longitude }) });
    }
    if (cfg.weather.sources.includes('buienradar')) {
      fetchers.push({ key: 'buienradar', label: 'Buienradar', p: fetchBuienradar({ latitude, longitude }) });
    }
    if (cfg.weather.sources.includes('openweathermap') && cfg.weather.openWeatherMapApiKey) {
      fetchers.push({
        key: 'openweathermap',
        label: 'OpenWeatherMap',
        p: fetchOpenWeatherMap({ latitude, longitude, apiKey: cfg.weather.openWeatherMapApiKey }),
      });
    }

    const settled = await Promise.allSettled(fetchers.map((f) => f.p));
    const snapshots = [];
    const sources = fetchers.map((f, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        snapshots.push(r.value);
        const s = r.value;
        return {
          key: f.key,
          label: f.label,
          ok: true,
          windSpeedMs: s.windSpeedMs ?? null,
          windDirectionDeg: s.windDirectionDeg ?? null,
          windOctant: s.windDirectionDeg != null ? degToOctant(s.windDirectionDeg) : null,
          rainLast24hMm: s.rainLast24hMm ?? null,
          rainNext12hMm: s.rainNext12hMm ?? null,
        };
      }
      return {
        key: f.key,
        label: f.label,
        ok: false,
        error: String(r.reason && r.reason.message ? r.reason.message : r.reason),
      };
    });

    // Rain blocking verdict.
    const rainDecision = evaluateRainBlocking(cfg.rain, snapshots, cfg.weather.consensusStrategy);

    // Highest measured values across all successful sources (for threshold comparison).
    const okSnaps = snapshots;

    // Representative wind: snapshot with the highest wind speed (worst case for blocking).
    const windSnaps = okSnaps.filter((s) => s.windSpeedMs != null);
    const measuredWind =
      windSnaps.length > 0
        ? (() => {
            const top = windSnaps.reduce((best, s) =>
              s.windSpeedMs > best.windSpeedMs ? s : best,
            );
            return {
              speedMs: top.windSpeedMs,
              directionDeg: top.windDirectionDeg ?? null,
              octant: top.windDirectionDeg != null ? degToOctant(top.windDirectionDeg) : null,
              source: top.source,
            };
          })()
        : null;
    const maxRain24h = okSnaps.reduce((m, s) => s.rainLast24hMm != null ? Math.max(m, s.rainLast24hMm) : m, -Infinity);
    const maxRain12h = okSnaps.reduce((m, s) => s.rainNext12hMm != null ? Math.max(m, s.rainNext12hMm) : m, -Infinity);

    const rain =
      rainDecision == null
        ? { enabled: false }
        : {
            enabled: true,
            blocked: rainDecision.blocked,
            explanation: rainDecision.explanation ?? null,
            blockingVotes: rainDecision.blockingVotes,
            totalVotes: rainDecision.totalVotes,
            thresholds: {
              past24hMm: cfg.rain?.past24hThresholdMm ?? 0,
              next12hMm: cfg.rain?.next12hThresholdMm ?? 0,
            },
            measured: {
              past24hMm: Number.isFinite(maxRain24h) ? maxRain24h : null,
              next12hMm: Number.isFinite(maxRain12h) ? maxRain12h : null,
            },
          };

    // Per-zone verdict. Every zone is returned (rain is global and affects them
    // all); the wind portion is per zone. Each dimension carries its own vote
    // tally so the UI can show how the chosen consensus rule was applied.
    const zones = cfg.zones.map((z) => {
      const dec = evaluateZoneBlocking(z, cfg.rain, snapshots, cfg.weather.consensusStrategy);
      const windEnabled = !!(z.windBlocking && z.windBlocking.enabled === true);
      return {
        id: z.id,
        name: z.name,
        windEnabled,
        windMinSpeedMs: windEnabled ? z.windBlocking.minimumWindSpeedMs ?? 0 : null,
        windOctants: windEnabled ? z.windBlocking.blockedOctants ?? [] : [],
        windBlocked: dec.wind?.blocked === true,
        windExplanation: dec.wind?.explanation ?? null,
        windVotes: dec.wind ? { blocking: dec.wind.blockingVotes, total: dec.wind.totalVotes } : null,
        rainBlocked: dec.rain?.blocked === true,
        rainVotes: dec.rain ? { blocking: dec.rain.blockingVotes, total: dec.rain.totalVotes } : null,
        blocked: dec.blocked === true,
      };
    });

    return {
      fetchedAt: new Date().toISOString(),
      windUnit: cfg.windUnit,
      consensusStrategy: cfg.weather.consensusStrategy,
      sources,
      rain,
      zones,
      measuredWind,
    };
  }

  /**
   * Unauthenticated bridge reachability probe. Used by the UI's "Status" dot
   * to confirm the bridge is on the LAN before the user tries to pair.
   */
  async probe(payload) {
    if (!payload || typeof payload.ip !== 'string' || payload.ip.length === 0) {
      throw new RequestError('probe-bridge requires an ip');
    }
    const client = new HueClient({
      ip: payload.ip,
      apiKey: 'probe',
      timeoutMs: 3000,
      retries: 0,
    });
    try {
      const cfg = await client.getConfig();
      return { ok: true, name: cfg.name, bridgeid: cfg.bridgeid, modelid: cfg.modelid };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
}

// eslint-disable-next-line no-new
new SmartIrrigationUiServer();
