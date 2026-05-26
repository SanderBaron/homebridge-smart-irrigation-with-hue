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

class SmartIrrigationUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/discover-bridges', (payload) => this.discover(payload));
    this.onRequest('/pair-bridge', (payload) => this.pair(payload));
    this.onRequest('/list-lights', (payload) => this.listLights(payload));
    this.onRequest('/probe-bridge', (payload) => this.probe(payload));

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
