/* global homebridge */
/* eslint-env browser */

/**
 * Smart Irrigation — Homebridge custom UI client script.
 *
 * Loads the existing plugin config, lets the user edit it via a friendly form
 * (no raw JSON), and saves back via the homebridge UI helpers. Communicates
 * with the plugin's UI server (`homebridge-ui/server.js`) for tasks that need
 * the host network: Hue discovery, pairing, light listing.
 */

'use strict';

const COMPASS_OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ZONE_TYPES = [
  ['sprinkler', 'Sprinkler'],
  ['dripLine', 'Drip line'],
  ['microSpray', 'Micro-spray'],
  ['mist', 'Mist'],
  ['other', 'Other'],
];

const TYPE_DEFAULTS = {
  sprinkler: {
    wind: { enabled: true, blockedOctants: ['NW', 'N', 'NE'], minimumWindSpeedMs: 6 },
    rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
  },
  dripLine: {
    wind: { enabled: false, blockedOctants: [], minimumWindSpeedMs: 0 },
    rain: { enabled: true, past24hThresholdMm: 8, next12hThresholdMm: 4 },
  },
  microSpray: {
    wind: { enabled: true, blockedOctants: ['NW', 'N', 'NE', 'E', 'SE'], minimumWindSpeedMs: 8 },
    rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
  },
  mist: {
    wind: {
      enabled: true,
      blockedOctants: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
      minimumWindSpeedMs: 4,
    },
    rain: { enabled: true, past24hThresholdMm: 3, next12hThresholdMm: 1 },
  },
  other: {
    wind: { enabled: false, blockedOctants: [], minimumWindSpeedMs: 0 },
    rain: { enabled: false, past24hThresholdMm: 0, next12hThresholdMm: 0 },
  },
};

const state = {
  /** Current config block (the one we edit + save). */
  config: defaultConfig(),
  /** Lights last fetched from the bridge, for dropdown populations. */
  lights: [],
};

function defaultConfig() {
  return {
    platform: 'SmartIrrigation',
    name: 'Smart Irrigation',
    hue: { bridgeIp: '', apiKey: '', healthCheckSec: 60 },
    location: { latitude: 52.37, longitude: 4.89, name: '' },
    zones: [],
    schedule: [],
    weather: {
      sources: ['open-meteo', 'buienradar'],
      openWeatherMapApiKey: '',
      consensusStrategy: 'majority',
      cacheMinutes: 10,
    },
    override: { autoResetMinutes: 60 },
    windUnit: 'm/s',
    logLevel: 'info',
  };
}

// ============================================================ entrypoint

(async function init() {
  applyThemeFromHomebridge();
  try {
    const configs = await homebridge.getPluginConfig();
    if (Array.isArray(configs) && configs.length > 0 && configs[0]) {
      state.config = mergeDefaults(configs[0]);
    }
    hydrateForm();
    wireEvents();
    if (state.config.hue.bridgeIp && state.config.hue.apiKey) {
      refreshLights().catch(() => undefined);
    }
  } catch (err) {
    homebridge.toast.error('Could not load plugin config: ' + describeError(err));
  }
})();

/**
 * Mirror Homebridge UI X's theme into our iframe via the `data-theme`
 * attribute on body. Tries three signals in order of reliability:
 *
 *  1. The parent document's body class. HB UI X writes `dark-mode` or
 *     `light-mode` (and named-theme classes). This is the source of truth
 *     — what the user actually sees in the surrounding UI.
 *  2. `homebridge.serverEnv.theme` — string from the server. Falls back here
 *     if step 1 is unavailable (sandboxed iframe, future API changes).
 *  3. The OS `prefers-color-scheme` via CSS only; this function just leaves
 *     `data-theme` unset and lets style.css handle it.
 */
function applyThemeFromHomebridge() {
  let resolved = null;

  // 1. Parent document class (most reliable — reflects what the user sees).
  try {
    if (window.parent && window.parent !== window && window.parent.document) {
      const cls = window.parent.document.body.classList;
      if (cls.contains('dark-mode')) {
        resolved = 'dark';
      } else if (cls.contains('light-mode')) {
        resolved = 'light';
      } else {
        // Inspect any class containing 'dark' / 'light' (named theme variants).
        for (const c of cls) {
          if (c.includes('dark')) {
            resolved = 'dark';
            break;
          }
          if (c.includes('light')) {
            resolved = 'light';
            break;
          }
        }
      }
    }
  } catch {
    // Cross-origin lockdown — fall through to other signals.
  }

  // 2. serverEnv.theme string from the Homebridge UI socket.
  if (resolved === null) {
    try {
      const theme = (homebridge && homebridge.serverEnv && homebridge.serverEnv.theme) || '';
      const normalized = String(theme).toLowerCase();
      if (normalized.includes('dark')) {
        resolved = 'dark';
      } else if (normalized.includes('light')) {
        resolved = 'light';
      }
    } catch {
      // ignore
    }
  }

  if (resolved !== null) {
    document.body.setAttribute('data-theme', resolved);
  }
  // Diagnostic — visible in DevTools to confirm detection during smoke tests.
  // eslint-disable-next-line no-console
  console.log(
    '[Smart Irrigation UI] resolved theme:',
    resolved ?? '(none — using prefers-color-scheme)',
  );
}

function mergeDefaults(cfg) {
  const base = defaultConfig();
  const zones = Array.isArray(cfg.zones) ? cfg.zones.map(migrateZone) : [];
  return {
    ...base,
    ...cfg,
    hue: { ...base.hue, ...(cfg.hue || {}) },
    location: { ...base.location, ...(cfg.location || {}) },
    weather: { ...base.weather, ...(cfg.weather || {}) },
    override: { ...base.override, ...(cfg.override || {}) },
    pump: cfg.pump || undefined,
    zones,
    schedule: Array.isArray(cfg.schedule) ? cfg.schedule : [],
  };
}

/**
 * Strip legacy fields and normalise the new shape. Plays the role of an
 * in-place schema migration whenever the UI loads an older config.
 */
function migrateZone(zone) {
  const clean = { ...zone };
  if ('concurrencyGroup' in clean) {
    delete clean.concurrencyGroup;
  }
  if (!Array.isArray(clean.runWith)) {
    clean.runWith = [];
  }
  return clean;
}

// ============================================================ wiring

function wireEvents() {
  document.getElementById('btn-discover').addEventListener('click', discoverBridges);
  document.getElementById('btn-probe').addEventListener('click', probeBridge);
  document.getElementById('btn-pair').addEventListener('click', pairBridge);
  document.getElementById('btn-refresh-lights').addEventListener('click', () => {
    refreshLights().catch((err) => homebridge.toast.error(describeError(err)));
  });

  document.getElementById('pump-enabled').addEventListener('change', (e) => {
    document.getElementById('pump-details').classList.toggle('hidden', !e.target.checked);
  });

  document.getElementById('btn-add-zone').addEventListener('click', () => {
    state.config.zones.push(makeNewZone());
    renderZones();
  });

  document.getElementById('btn-add-entry').addEventListener('click', () => {
    state.config.schedule.push(makeNewEntry());
    renderSchedule();
  });

  // Auto-sync to the parent's in-memory config on every change. The user
  // clicks Homebridge UI X's native "OPSLAAN" / Save button (in the modal
  // footer, outside the iframe) to actually write the config to disk — we
  // just keep the parent's view of the config up to date.
  document.body.addEventListener('change', queueSync);
  document.body.addEventListener('input', queueSync);
}

let syncTimer = null;
function queueSync() {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncToParent();
  }, 350);
}

async function syncToParent() {
  const feedback = document.getElementById('save-feedback');
  feedback.textContent = '';
  feedback.className = 'save-feedback';
  const cfg = serialise();
  const issues = validate(cfg);
  try {
    await homebridge.updatePluginConfig([cfg]);
    if (issues.length === 0) {
      feedback.textContent = 'Changes ready — click Save below to write to disk.';
      feedback.classList.add('muted');
    } else {
      feedback.textContent = 'Changes ready, but: ' + issues.join('; ');
      feedback.classList.add('error');
    }
  } catch (err) {
    feedback.textContent = 'Could not sync to Homebridge: ' + describeError(err);
    feedback.classList.add('error');
  }
}

// ============================================================ hydrate / serialise

function hydrateForm() {
  const c = state.config;

  setValue('hue-ip', c.hue.bridgeIp || '');
  setValue('hue-api-key', c.hue.apiKey || '');
  setValue('hue-health-sec', c.hue.healthCheckSec || 60);

  setValue('loc-lat', c.location.latitude);
  setValue('loc-lon', c.location.longitude);
  setValue('loc-name', c.location.name || '');

  const pump = c.pump;
  document.getElementById('pump-enabled').checked = !!(pump && pump.enabled);
  document.getElementById('pump-details').classList.toggle('hidden', !(pump && pump.enabled));
  if (pump) {
    setValue('pump-pre', pump.preRunSec ?? 3);
    setValue('pump-post', pump.postRunSec ?? 5);
  }

  document.getElementById('src-open-meteo').checked = (c.weather.sources || []).includes(
    'open-meteo',
  );
  document.getElementById('src-buienradar').checked = (c.weather.sources || []).includes(
    'buienradar',
  );
  document.getElementById('src-owm').checked = (c.weather.sources || []).includes('openweathermap');
  setValue('owm-key', c.weather.openWeatherMapApiKey || '');
  setValue('consensus-strategy', c.weather.consensusStrategy || 'majority');
  setValue('weather-cache-min', c.weather.cacheMinutes || 10);

  setValue('override-reset-min', c.override.autoResetMinutes || 60);
  setValue('wind-unit', c.windUnit || 'm/s');
  setValue('log-level', c.logLevel || 'info');

  renderZones();
  renderSchedule();
  updatePumpZones();

  if (c.hue.bridgeIp && c.hue.apiKey) {
    setStatus('status-online', 'Connected (cached)');
  }
}

function serialise() {
  const c = state.config;
  c.name = 'Smart Irrigation';
  c.platform = 'SmartIrrigation';
  c.hue.bridgeIp = readValue('hue-ip', 'string').trim();
  c.hue.apiKey = readValue('hue-api-key', 'string').trim();
  c.hue.healthCheckSec = Math.max(15, Number(readValue('hue-health-sec', 'number') || 60));

  c.location.latitude = Number(readValue('loc-lat', 'number'));
  c.location.longitude = Number(readValue('loc-lon', 'number'));
  c.location.name = readValue('loc-name', 'string').trim();

  if (document.getElementById('pump-enabled').checked) {
    const pumpLight = readValue('pump-light', 'string');
    const zoneIds = [...document.querySelectorAll('#pump-zones input:checked')].map(
      (el) => el.value,
    );
    c.pump = {
      enabled: true,
      hueLightId: pumpLight,
      preRunSec: Math.max(0, Number(readValue('pump-pre', 'number') || 3)),
      postRunSec: Math.max(0, Number(readValue('pump-post', 'number') || 5)),
      zoneIds,
    };
  } else {
    delete c.pump;
  }

  const sources = [];
  if (document.getElementById('src-open-meteo').checked) sources.push('open-meteo');
  if (document.getElementById('src-buienradar').checked) sources.push('buienradar');
  if (document.getElementById('src-owm').checked) sources.push('openweathermap');
  c.weather.sources = sources;
  c.weather.openWeatherMapApiKey = readValue('owm-key', 'string').trim();
  c.weather.consensusStrategy = readValue('consensus-strategy', 'string');
  c.weather.cacheMinutes = Math.max(1, Number(readValue('weather-cache-min', 'number') || 10));

  c.override.autoResetMinutes = Math.max(
    5,
    Number(readValue('override-reset-min', 'number') || 60),
  );
  c.windUnit = readValue('wind-unit', 'string');
  c.logLevel = readValue('log-level', 'string');

  // Zones and schedule are already kept in state.config.zones/schedule as the
  // user edits them — renderZones/renderSchedule write directly back.

  return c;
}

// ============================================================ zones

function makeNewZone() {
  const id = 'zone-' + Math.random().toString(36).slice(2, 10);
  const type = 'sprinkler';
  const defaults = TYPE_DEFAULTS[type];
  return {
    id,
    name: 'New zone',
    type,
    hueLightId: '',
    runWith: [],
    windBlocking: JSON.parse(JSON.stringify(defaults.wind)),
    rainBlocking: JSON.parse(JSON.stringify(defaults.rain)),
  };
}

function renderZones() {
  const list = document.getElementById('zones-list');
  if (state.config.zones.length === 0) {
    list.innerHTML = '<p class="empty">No zones yet — click "Add zone" to define one.</p>';
    updatePumpZones();
    return;
  }
  list.innerHTML = '';
  state.config.zones.forEach((zone, idx) => {
    list.appendChild(buildZoneCard(zone, idx));
  });
  updatePumpZones();
}

function buildZoneCard(zone, idx) {
  const card = document.createElement('div');
  card.className = 'item-card';

  const lightsOptions = renderLightOptions(zone.hueLightId);
  const octantBoxes = COMPASS_OCTANTS.map((o) => {
    const checked = (zone.windBlocking.blockedOctants || []).includes(o) ? 'checked' : '';
    return `<label><input type="checkbox" data-octant="${o}" ${checked} /> ${o}</label>`;
  }).join('');

  card.innerHTML = `
    <div class="item-head">
      <span class="item-title">${escapeHtml(zone.name)}</span>
      <button type="button" class="danger small" data-action="remove">Remove</button>
    </div>
    <div class="item-body">
      <div class="form-grid two">
        <label>Name
          <input type="text" data-field="name" value="${escapeHtml(zone.name)}" />
        </label>
        <label>Type
          <select data-field="type">
            ${ZONE_TYPES.map(
              ([v, label]) =>
                `<option value="${v}"${v === zone.type ? ' selected' : ''}>${label}</option>`,
            ).join('')}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>Hue outlet
          <select data-field="hueLightId">${lightsOptions}</select>
        </label>
      </div>
      <fieldset>
        <legend>Run alongside this zone</legend>
        <p class="hint">When this zone starts (manually or via schedule), the zones you tick here also start for the same duration. Useful e.g. when a drip line should water on top of whichever sprinkler is running.</p>
        <div class="check-list" data-runwith-list>${buildRunWithList(zone)}</div>
      </fieldset>
      <fieldset>
        <legend>
          <label class="toggle"><input type="checkbox" data-field="windEnabled" ${zone.windBlocking.enabled ? 'checked' : ''} /> Wind blocking</label>
        </legend>
        <div class="form-grid two">
          <label>Minimum wind speed (m/s)
            <input type="number" data-field="windMinMs" min="0" max="50" step="0.5" value="${zone.windBlocking.minimumWindSpeedMs}" />
          </label>
        </div>
        <span>Blocked when wind is from:</span>
        <div class="octant-row" data-zone-octants>${octantBoxes}</div>
      </fieldset>
      <fieldset>
        <legend>
          <label class="toggle"><input type="checkbox" data-field="rainEnabled" ${zone.rainBlocking.enabled ? 'checked' : ''} /> Rain skip</label>
        </legend>
        <div class="form-grid two">
          <label>Past 24h threshold (mm)
            <input type="number" data-field="rainPast" min="0" max="100" step="0.5" value="${zone.rainBlocking.past24hThresholdMm}" />
          </label>
          <label>Forecast 12h threshold (mm)
            <input type="number" data-field="rainNext" min="0" max="100" step="0.5" value="${zone.rainBlocking.next12hThresholdMm}" />
          </label>
        </div>
      </fieldset>
    </div>
  `;

  // Wire field updates back into state.config.zones[idx]
  card.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', () => writeZoneField(idx, el));
    el.addEventListener('input', () => writeZoneField(idx, el));
  });
  card.querySelectorAll('[data-octant]').forEach((el) => {
    el.addEventListener('change', () => writeZoneOctants(idx));
  });
  card.querySelectorAll('[data-runwith]').forEach((el) => {
    el.addEventListener('change', () => writeZoneRunWith(idx));
  });
  card.querySelector('[data-action="remove"]').addEventListener('click', () => {
    confirmModal(`Remove zone "${state.config.zones[idx].name}"?`).then((ok) => {
      if (!ok) return;
      state.config.zones.splice(idx, 1);
      renderZones();
    });
  });

  // Apply smart defaults when type changes (after first user choice)
  card.querySelector('[data-field="type"]').addEventListener('change', (e) => {
    const newType = e.target.value;
    if (
      confirmModalSync(
        `Apply default wind / rain settings for type "${newType}"? Your current settings will be overwritten.`,
      )
    ) {
      const d = TYPE_DEFAULTS[newType];
      state.config.zones[idx].windBlocking = JSON.parse(JSON.stringify(d.wind));
      state.config.zones[idx].rainBlocking = JSON.parse(JSON.stringify(d.rain));
      renderZones();
    }
  });

  return card;
}

function writeZoneField(idx, el) {
  const z = state.config.zones[idx];
  const f = el.dataset.field;
  const val = el.type === 'checkbox' ? el.checked : el.value;
  switch (f) {
    case 'name':
      z.name = String(val);
      break;
    case 'type':
      z.type = String(val);
      break;
    case 'hueLightId':
      z.hueLightId = String(val);
      break;
    case 'windEnabled':
      z.windBlocking.enabled = Boolean(val);
      break;
    case 'windMinMs':
      z.windBlocking.minimumWindSpeedMs = Number(val);
      break;
    case 'rainEnabled':
      z.rainBlocking.enabled = Boolean(val);
      break;
    case 'rainPast':
      z.rainBlocking.past24hThresholdMm = Number(val);
      break;
    case 'rainNext':
      z.rainBlocking.next12hThresholdMm = Number(val);
      break;
  }
}

function buildRunWithList(zone) {
  const others = state.config.zones.filter((z) => z.id !== zone.id);
  if (others.length === 0) {
    return '<p class="muted">No other zones yet — add another zone to choose buddies.</p>';
  }
  return others
    .map((other) => {
      const checked = (zone.runWith || []).includes(other.id) ? 'checked' : '';
      return `<label><input type="checkbox" data-runwith="${escapeHtml(other.id)}" ${checked} /> ${escapeHtml(other.name)}</label>`;
    })
    .join('');
}

function writeZoneRunWith(idx) {
  const card = document.querySelectorAll('#zones-list .item-card')[idx];
  const ids = [...card.querySelectorAll('[data-runwith]:checked')].map((el) => el.dataset.runwith);
  if (ids.length > 0) {
    state.config.zones[idx].runWith = ids;
  } else {
    delete state.config.zones[idx].runWith;
  }
}

function writeZoneOctants(idx) {
  const card = document.querySelectorAll('#zones-list .item-card')[idx];
  const checked = [...card.querySelectorAll('[data-octant]:checked')].map(
    (el) => el.dataset.octant,
  );
  state.config.zones[idx].windBlocking.blockedOctants = checked;
}

// ============================================================ schedule

function makeNewEntry() {
  return {
    id: 'entry-' + Math.random().toString(36).slice(2, 10),
    name: 'New entry',
    days: ['Mon', 'Wed', 'Fri'],
    startTime: '08:00',
    durationMin: 10,
    zoneIds: [],
  };
}

function renderSchedule() {
  const list = document.getElementById('schedule-list');
  if (state.config.schedule.length === 0) {
    list.innerHTML =
      '<p class="empty">No schedule entries yet — the plugin will run in manual mode only.</p>';
    return;
  }
  list.innerHTML = '';
  state.config.schedule.forEach((entry, idx) => {
    list.appendChild(buildEntryCard(entry, idx));
  });
}

function buildEntryCard(entry, idx) {
  const card = document.createElement('div');
  card.className = 'item-card';

  const days = WEEKDAYS.map((d) => {
    const checked = entry.days.includes(d) ? 'checked' : '';
    return `<label><input type="checkbox" data-day="${d}" ${checked} /> ${d}</label>`;
  }).join('');

  const zonesChecks = state.config.zones
    .map(
      (z) =>
        `<label><input type="checkbox" data-zone="${z.id}" ${entry.zoneIds.includes(z.id) ? 'checked' : ''} /> ${escapeHtml(z.name)}</label>`,
    )
    .join('');

  card.innerHTML = `
    <div class="item-head">
      <span class="item-title">${escapeHtml(entry.name)}</span>
      <button type="button" class="danger small" data-action="remove">Remove</button>
    </div>
    <div class="item-body">
      <div class="form-grid two">
        <label>Name
          <input type="text" data-field="name" value="${escapeHtml(entry.name)}" />
        </label>
        <label>Start time (HH:MM)
          <input type="text" data-field="startTime" value="${escapeHtml(entry.startTime)}" pattern="^([01][0-9]|2[0-3]):[0-5][0-9]$" />
        </label>
      </div>
      <div class="form-grid two">
        <label>Duration (minutes)
          <input type="number" data-field="durationMin" min="1" max="240" value="${entry.durationMin}" />
        </label>
      </div>
      <span>Days</span>
      <div class="check-list" data-days>${days}</div>
      <span>Zones</span>
      <div class="check-list" data-zones>${zonesChecks || '<p class="muted">Define a zone first.</p>'}</div>
    </div>
  `;

  card.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('change', () => writeEntryField(idx, el));
    el.addEventListener('input', () => writeEntryField(idx, el));
  });
  card.querySelectorAll('[data-day]').forEach((el) => {
    el.addEventListener('change', () => writeEntryDays(idx));
  });
  card.querySelectorAll('[data-zone]').forEach((el) => {
    el.addEventListener('change', () => writeEntryZones(idx));
  });
  card.querySelector('[data-action="remove"]').addEventListener('click', () => {
    confirmModal(`Remove schedule entry "${state.config.schedule[idx].name}"?`).then((ok) => {
      if (!ok) return;
      state.config.schedule.splice(idx, 1);
      renderSchedule();
    });
  });

  return card;
}

function writeEntryField(idx, el) {
  const e = state.config.schedule[idx];
  const f = el.dataset.field;
  if (f === 'durationMin') {
    e.durationMin = Number(el.value);
  } else if (f === 'name' || f === 'startTime') {
    e[f] = String(el.value);
  }
}

function writeEntryDays(idx) {
  const card = document.querySelectorAll('#schedule-list .item-card')[idx];
  state.config.schedule[idx].days = [...card.querySelectorAll('[data-day]:checked')].map(
    (el) => el.dataset.day,
  );
}

function writeEntryZones(idx) {
  const card = document.querySelectorAll('#schedule-list .item-card')[idx];
  state.config.schedule[idx].zoneIds = [...card.querySelectorAll('[data-zone]:checked')].map(
    (el) => el.dataset.zone,
  );
}

// ============================================================ hue actions

async function discoverBridges() {
  homebridge.showSpinner();
  try {
    const result = await homebridge.request('/discover-bridges', { timeoutMs: 5000 });
    const container = document.getElementById('discovery-results');
    container.innerHTML = '';
    container.classList.remove('hidden');
    if (!result || result.length === 0) {
      container.innerHTML = '<p class="muted">No Hue Bridges found on the LAN.</p>';
      return;
    }
    result.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'result';
      row.innerHTML = `
        <span><strong>${escapeHtml(c.name || c.id)}</strong> · ${escapeHtml(c.ip)} <span class="muted">(${c.source})</span></span>
        <button type="button" class="primary small">Use</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        setValue('hue-ip', c.ip);
        state.config.hue.bridgeIp = c.ip;
        container.classList.add('hidden');
      });
      container.appendChild(row);
    });
  } catch (err) {
    homebridge.toast.error(describeError(err));
  } finally {
    homebridge.hideSpinner();
  }
}

async function probeBridge() {
  const ip = readValue('hue-ip', 'string').trim();
  if (!ip) {
    homebridge.toast.warning('Enter a Bridge IP first');
    return;
  }
  setStatus('status-pending', 'Probing...');
  try {
    const result = await homebridge.request('/probe-bridge', { ip });
    if (result && result.ok) {
      setStatus('status-online', `Online (${result.name || result.bridgeid || ''})`);
    } else {
      setStatus('status-offline', `Unreachable: ${describeError(result && result.error)}`);
    }
  } catch (err) {
    setStatus('status-offline', describeError(err));
  }
}

async function pairBridge() {
  const ip = readValue('hue-ip', 'string').trim();
  if (!ip) {
    homebridge.toast.warning('Enter or discover the Bridge IP first');
    return;
  }
  homebridge.toast.info('Press the round button on top of your Hue Bridge, then wait...');
  const start = Date.now();
  const deadline = start + 30_000;

  while (Date.now() < deadline) {
    try {
      const result = await homebridge.request('/pair-bridge', { ip });
      if (result && result.ok) {
        state.config.hue.apiKey = result.apiKey;
        state.config.hue.bridgeIp = ip;
        setValue('hue-api-key', result.apiKey);
        homebridge.toast.success('Paired successfully — fetching lights...');
        setStatus('status-online', 'Connected');
        await refreshLights();
        return;
      }
      if (result && result.kind === 'link-not-pressed') {
        await delay(2000);
        continue;
      }
    } catch (err) {
      homebridge.toast.error(describeError(err));
      return;
    }
  }
  homebridge.toast.error('Pairing timed out — please press the button and try again.');
}

async function refreshLights() {
  const ip = state.config.hue.bridgeIp;
  const apiKey = state.config.hue.apiKey;
  if (!ip || !apiKey) {
    homebridge.toast.warning('Pair the bridge before listing lights.');
    return;
  }
  homebridge.showSpinner();
  try {
    state.lights = await homebridge.request('/list-lights', { ip, apiKey });
    renderLights();
    // Re-render zone cards so their outlet dropdowns pick up new lights.
    renderZones();
    populatePumpLightOptions();
  } catch (err) {
    homebridge.toast.error(describeError(err));
  } finally {
    homebridge.hideSpinner();
  }
}

function renderLights() {
  const container = document.getElementById('hue-lights');
  if (!state.lights || state.lights.length === 0) {
    container.innerHTML = '<p class="empty">No lights detected.</p>';
    return;
  }
  container.innerHTML = '';
  state.lights.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'light-row';
    row.innerHTML = `<span>#${l.id} · ${escapeHtml(l.name)}</span><span class="muted">${escapeHtml(l.type)}</span>`;
    container.appendChild(row);
  });
}

function renderLightOptions(selectedId) {
  const opts = ['<option value="">(select an outlet)</option>'];
  for (const l of state.lights) {
    const sel = String(l.id) === String(selectedId) ? ' selected' : '';
    opts.push(
      `<option value="${escapeHtml(String(l.id))}"${sel}>#${l.id} ${escapeHtml(l.name)}</option>`,
    );
  }
  return opts.join('');
}

function populatePumpLightOptions() {
  const sel = document.getElementById('pump-light');
  const current = (state.config.pump && state.config.pump.hueLightId) || '';
  sel.innerHTML = renderLightOptions(current);
}

function updatePumpZones() {
  const container = document.getElementById('pump-zones');
  if (!container) return;
  populatePumpLightOptions();
  if (state.config.zones.length === 0) {
    container.innerHTML = '<p class="muted">Define a zone first.</p>';
    return;
  }
  const pumpZones = (state.config.pump && state.config.pump.zoneIds) || [];
  const allDefault = pumpZones.length === 0;
  container.innerHTML = state.config.zones
    .map(
      (z) =>
        `<label><input type="checkbox" value="${escapeHtml(z.id)}" ${
          allDefault || pumpZones.includes(z.id) ? 'checked' : ''
        } /> ${escapeHtml(z.name)}</label>`,
    )
    .join('');
}

// ============================================================ validation

function validate(cfg) {
  const issues = [];
  if (!Number.isFinite(cfg.location.latitude) || Math.abs(cfg.location.latitude) > 90) {
    issues.push('latitude must be between -90 and 90');
  }
  if (!Number.isFinite(cfg.location.longitude) || Math.abs(cfg.location.longitude) > 180) {
    issues.push('longitude must be between -180 and 180');
  }
  if (cfg.zones.length > 0 && cfg.hue.bridgeIp === '') {
    issues.push('configure the Hue Bridge before saving zones');
  }
  for (const z of cfg.zones) {
    if (!z.name) issues.push(`zone ${z.id}: name is required`);
    if (!z.hueLightId) issues.push(`zone ${z.name || z.id}: select a Hue outlet`);
  }
  for (const e of cfg.schedule) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.startTime)) {
      issues.push(`schedule "${e.name}": startTime must be HH:MM`);
    }
    if (!(e.durationMin > 0)) {
      issues.push(`schedule "${e.name}": durationMin must be > 0`);
    }
    if (!e.days || e.days.length === 0) {
      issues.push(`schedule "${e.name}": choose at least one day`);
    }
  }
  if (cfg.weather.sources.includes('openweathermap') && !cfg.weather.openWeatherMapApiKey) {
    issues.push('OpenWeatherMap enabled but no API key provided');
  }
  return issues;
}

// ============================================================ misc helpers

function setValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = !!value;
  } else {
    el.value = value === undefined || value === null ? '' : String(value);
  }
}

function readValue(id, kind) {
  const el = document.getElementById(id);
  if (!el) return kind === 'number' ? 0 : '';
  if (el.type === 'checkbox') return el.checked;
  if (kind === 'number') return Number(el.value);
  return el.value;
}

function setStatus(cls, text) {
  const dot = document.getElementById('hue-status-dot');
  const lbl = document.getElementById('hue-status-text');
  dot.className = 'status-dot ' + cls;
  lbl.textContent = text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return String(err);
}

function confirmModal(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-text').textContent = message;
    modal.classList.remove('hidden');
    const cleanup = (result) => {
      modal.classList.add('hidden');
      document.getElementById('confirm-ok').onclick = null;
      document.getElementById('confirm-cancel').onclick = null;
      resolve(result);
    };
    document.getElementById('confirm-ok').onclick = () => cleanup(true);
    document.getElementById('confirm-cancel').onclick = () => cleanup(false);
  });
}

/** Synchronous-feel confirm for the type-change case (uses native confirm). */
function confirmModalSync(message) {
  // eslint-disable-next-line no-alert
  return window.confirm(message);
}
