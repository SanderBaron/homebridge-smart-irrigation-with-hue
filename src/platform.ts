import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { evaluateRainBlocking, evaluateZoneBlocking } from './blockingEngine';
import { parseConfig, type SmartIrrigationConfig } from './config';
import { HueClient } from './hue/client';
import { PumpOrchestrator } from './pumpOrchestrator';
import { Scheduler } from './scheduler';
import { SmartIrrigationAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { defaultState, StateStore, type PersistentState } from './state';
import { TtlCache } from './ttlCache';
import { fetchBuienradar } from './weather/buienradar';
import { fetchOpenMeteo } from './weather/openMeteo';
import { fetchOpenWeatherMap } from './weather/openWeatherMap';
import type { WeatherSnapshot } from './weather/types';

const ACCESSORY_NAME = 'Smart Irrigation';
const SCHEDULER_TICK_MS = 30 * 1000;

/**
 * Smart Irrigation Homebridge platform.
 *
 * Wires together the per-layer modules from the earlier phases:
 *
 * - **Hue layer** ({@link HueClient}) drives the smart sockets.
 * - **Weather layer** (Open-Meteo / Buienradar / OpenWeatherMap) feeds the
 *   blocking engine; results are memoised in a {@link TtlCache}.
 * - **Blocking engine** projects weather + per-zone thresholds into a
 *   block / don't-block verdict. Blocking applies to the scheduled programme
 *   only — manual valve opens and "Run Schedule Now" always water.
 * - **Pump orchestrator** sequences pre-/post-run timing for the optional
 *   central pump.
 * - **Scheduler** fires schedule entries with concurrency-group awareness.
 *
 * The full configuration UI lands in Phase 9 — until then, config is read
 * from `config.json` and the platform tolerates a sparse config so it can
 * load while the user is still pairing the bridge and adding zones.
 */
export class SmartIrrigationPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private parsedConfig: SmartIrrigationConfig | undefined;
  private hueClient: HueClient | undefined;
  private pump: PumpOrchestrator | undefined;
  private scheduler: Scheduler | undefined;
  private weatherCache: TtlCache<WeatherSnapshot[]> | undefined;
  private accessoryBuilder: SmartIrrigationAccessory | undefined;
  private hueOnline = false;
  private readonly intervalTimers: NodeJS.Timeout[] = [];
  private stateStore: StateStore | undefined;
  private persistentState: PersistentState = defaultState();
  private savePending: Promise<void> = Promise.resolve();
  /**
   * Dedup key for the global rain-block info log. Only re-emits when the
   * blocked/not-blocked state or the human-readable explanation actually
   * changes between weather refreshes, so a stable rainy spell logs once
   * instead of once per zone evaluation.
   */
  private lastRainStateKey: string | undefined;

  public constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Initializing %s platform', PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      void this.bootstrap();
    });
    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring accessory from cache: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  // ---------------- bootstrap ----------------

  private async bootstrap(): Promise<void> {
    const result = parseConfig(this.config);
    if (!result.ok) {
      this.log.error(
        'Configuration error — platform will not register accessories: %s',
        result.error,
      );
      return;
    }
    this.parsedConfig = result.config;

    this.stateStore = new StateStore({
      storageDir: this.api.user.storagePath(),
      log: this.log,
    });
    this.persistentState = await this.stateStore.load();
    this.log.debug(
      'Loaded persistent state from %s (savedAt=%s, %d snapshots)',
      this.stateStore.path(),
      new Date(this.persistentState.savedAt).toISOString(),
      this.persistentState.weatherSnapshots.length,
    );

    const hueReady = result.config.hue.bridgeIp !== '' && result.config.hue.apiKey !== '';
    if (!hueReady) {
      this.log.warn(
        'Hue Bridge IP / API key not configured. Run the pairing flow from the plugin UI before the platform can drive valves.',
      );
    } else {
      this.hueClient = new HueClient({
        ip: result.config.hue.bridgeIp,
        apiKey: result.config.hue.apiKey,
        log: this.log,
      });
    }

    this.weatherCache = new TtlCache<WeatherSnapshot[]>(
      result.config.weather.cacheMinutes * 60 * 1000,
    );

    this.pump = new PumpOrchestrator({
      config: result.config.pump ?? {
        enabled: false,
        hueLightId: '',
        preRunSec: 0,
        postRunSec: 0,
        zoneIds: [],
      },
      setPumpState: async (on) => {
        const lightId = result.config.pump?.hueLightId;
        if (lightId !== undefined && lightId !== '' && this.hueClient !== undefined) {
          await this.hueClient.setLightOn(lightId, on);
        }
      },
      log: this.log,
    });

    this.scheduler = new Scheduler({
      startZone: async (zoneId, durationMs) => {
        await this.accessoryBuilder?.startZoneFromSchedule(zoneId, durationMs);
      },
      stopZone: async (zoneId) => {
        await this.accessoryBuilder?.stopZoneFromSchedule(zoneId);
      },
      isZoneBlocked: (zoneId) => this.isZoneBlocked(zoneId),
      onStateChange: () => this.schedulePersist(),
      onManualRunStateChange: (active) => {
        this.accessoryBuilder?.syncManualRunSwitch(active);
      },
      log: this.log,
    });
    this.scheduler.setZones(result.config.zones);
    this.scheduler.setEntries(result.config.schedule);
    this.scheduler.restoreFiredToday(this.persistentState.schedulerFiredToday);
    if (this.persistentState.scheduleActive) {
      this.scheduler.setActive(true);
    }

    if (this.persistentState.weatherSnapshots.length > 0) {
      this.weatherCache.set(this.persistentState.weatherSnapshots);
    }

    this.buildOrRestoreAccessory(result.config);
    this.startPeriodicTimers();

    if (hueReady) {
      // Kick off an immediate health check so we know the bridge state before the first timer tick.
      void this.runHueHealthCheck();
    }
  }

  private buildOrRestoreAccessory(config: SmartIrrigationConfig): void {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:irrigation`);
    let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
    if (accessory === undefined) {
      accessory = new this.api.platformAccessory(ACCESSORY_NAME, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Registered new platform accessory: %s', ACCESSORY_NAME);
    } else {
      this.log.debug('Reusing cached platform accessory: %s', accessory.displayName);
    }

    if (this.pump === undefined || this.scheduler === undefined) {
      return;
    }

    this.accessoryBuilder = new SmartIrrigationAccessory(this, accessory, {
      config,
      hueClient: this.hueClient,
      pump: this.pump,
      scheduler: this.scheduler,
      isHueOnline: () => this.hueOnline,
      initialDurations: this.persistentState.valveDurations ?? {},
      onSetDuration: (zoneId, seconds) => {
        if (this.persistentState.valveDurations === undefined) {
          this.persistentState.valveDurations = {};
        }
        this.persistentState.valveDurations[zoneId] = seconds;
        this.schedulePersist();
      },
    });

    this.api.updatePlatformAccessories([accessory]);
  }

  private startPeriodicTimers(): void {
    if (this.scheduler !== undefined) {
      this.intervalTimers.push(setInterval(() => this.scheduler?.tick(), SCHEDULER_TICK_MS));
    }
    if (this.parsedConfig !== undefined && this.hueClient !== undefined) {
      const healthMs = this.parsedConfig.hue.healthCheckSec * 1000;
      this.intervalTimers.push(
        setInterval(() => {
          void this.runHueHealthCheck();
        }, healthMs),
      );
    }
    if (this.parsedConfig !== undefined && this.weatherCache !== undefined) {
      const refreshMs = this.parsedConfig.weather.cacheMinutes * 60 * 1000;
      this.intervalTimers.push(
        setInterval(() => {
          void this.refreshWeatherCache();
        }, refreshMs),
      );
      // Prime the cache once at startup so the first scheduler tick has data.
      void this.refreshWeatherCache();
    }
  }

  // ---------------- weather + blocking ----------------

  private async refreshWeatherCache(): Promise<void> {
    if (this.parsedConfig === undefined || this.weatherCache === undefined) {
      return;
    }
    try {
      const before = this.weatherCache.peek();
      await this.weatherCache.getOrCompute(async () => this.fetchAllSources());
      const after = this.weatherCache.peek();
      if (after !== undefined && after !== before) {
        this.schedulePersist();
      }
      if (after !== undefined) {
        this.logRainStateIfChanged(after);
      }
    } catch (err) {
      this.log.warn('Weather refresh failed: %s', String(err));
    }
  }

  /**
   * Emit a single info-level summary of the current global rain decision
   * whenever it changes (blocked / not blocked, or the explanation text).
   * Lets `isZoneBlocked` keep its per-zone "blocked by rain" lines short —
   * the full multi-source reasoning is already in the log at the most recent
   * weather-refresh timestamp.
   */
  private logRainStateIfChanged(snapshots: WeatherSnapshot[]): void {
    if (this.parsedConfig === undefined) {
      return;
    }
    const decision = evaluateRainBlocking(
      this.parsedConfig.rain,
      snapshots,
      this.parsedConfig.weather.consensusStrategy,
    );
    const key =
      decision === undefined
        ? 'off'
        : `${decision.blocked ? 'block' : 'clear'}:${decision.explanation ?? ''}`;
    if (key === this.lastRainStateKey) {
      return;
    }
    this.lastRainStateKey = key;
    if (decision === undefined) {
      return; // rain blocking disabled in config — no need to log
    }
    if (decision.blocked) {
      this.log.info('Rain block active: %s', decision.explanation ?? 'rain consensus');
    } else if (decision.totalVotes > 0) {
      this.log.info(
        'Rain block cleared (%d of %d sources voted block)',
        decision.blockingVotes,
        decision.totalVotes,
      );
    }
  }

  private async fetchAllSources(): Promise<WeatherSnapshot[]> {
    if (this.parsedConfig === undefined) {
      return [];
    }
    const { latitude, longitude } = this.parsedConfig.location;
    const sources = this.parsedConfig.weather.sources;
    const apiKey = this.parsedConfig.weather.openWeatherMapApiKey;

    const tasks: Array<Promise<WeatherSnapshot>> = [];
    if (sources.includes('open-meteo')) {
      tasks.push(fetchOpenMeteo({ latitude, longitude }));
    }
    if (sources.includes('buienradar')) {
      tasks.push(fetchBuienradar({ latitude, longitude }));
    }
    if (sources.includes('openweathermap') && apiKey !== undefined) {
      tasks.push(fetchOpenWeatherMap({ latitude, longitude, apiKey }));
    }
    const results = await Promise.allSettled(tasks);
    const ok: WeatherSnapshot[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok.push(r.value);
      } else {
        this.log.info('Weather source failure (skipping in consensus): %s', String(r.reason));
      }
    }
    return ok;
  }

  private isZoneBlocked(zoneId: string): boolean {
    if (this.parsedConfig === undefined) {
      return false;
    }
    const zone = this.parsedConfig.zones.find((z) => z.id === zoneId);
    if (zone === undefined) {
      return false;
    }
    const snapshots = this.weatherCache?.peek() ?? [];
    const decision = evaluateZoneBlocking(
      zone,
      this.parsedConfig.rain,
      snapshots,
      this.parsedConfig.weather.consensusStrategy,
    );

    const windBlocking = decision.wind?.blocked === true;
    const rainBlocking = decision.rain?.blocked === true;

    if (windBlocking || rainBlocking) {
      const reasons: string[] = [];
      if (windBlocking) {
        // Wind reason stays full — it's per-zone (octant + speed) and won't
        // be in any earlier log line.
        reasons.push(decision.wind?.explanation ?? 'wind');
      }
      if (rainBlocking) {
        // Rain reason is the same across every zone, and the full multi-
        // source explanation was already logged once at the most recent
        // weather refresh — keep the per-zone line short here.
        reasons.push('rain');
      }
      this.log.info('Zone %s blocked: %s', zoneId, reasons.join('; '));
      return true;
    }
    return false;
  }

  // ---------------- hue health ----------------

  private async runHueHealthCheck(): Promise<void> {
    if (this.hueClient === undefined) {
      return;
    }
    const wasOnline = this.hueOnline;
    this.hueOnline = await this.hueClient.healthCheck();
    if (wasOnline && !this.hueOnline) {
      this.log.error('Hue Bridge unreachable — closing all valves in plugin state');
      await this.accessoryBuilder?.closeAllValves('hue-offline');
    } else if (!wasOnline && this.hueOnline) {
      this.log.info('Hue Bridge reachable again');
    }
  }

  // ---------------- persistence ----------------

  /**
   * Capture current state from every subsystem and serialise to disk. Calls
   * are serialised through `savePending` so concurrent change events never
   * race on the temp file. Errors are logged by {@link StateStore}, not
   * thrown.
   */
  private schedulePersist(): void {
    if (this.stateStore === undefined) {
      return;
    }
    this.savePending = this.savePending.then(() => this.persistNow());
  }

  private async persistNow(): Promise<void> {
    if (this.stateStore === undefined) {
      return;
    }
    const snapshot: PersistentState = {
      ...this.persistentState,
      scheduleActive: this.scheduler?.isActive() ?? false,
      schedulerFiredToday: this.scheduler?.getFiredTodaySnapshot() ?? {},
      weatherSnapshots: this.weatherCache?.peek() ?? [],
    };
    this.persistentState = snapshot;
    await this.stateStore.save(snapshot);
  }

  // ---------------- shutdown ----------------

  private async shutdown(): Promise<void> {
    this.log.info('%s shutting down', PLATFORM_NAME);
    for (const t of this.intervalTimers) {
      clearInterval(t);
    }
    this.intervalTimers.length = 0;
    void this.pump?.forceStop();
    void this.scheduler?.stopAll();
    void this.accessoryBuilder?.closeAllValves('shutdown');

    // Persist a final snapshot on the way out.
    this.schedulePersist();
    await this.savePending;
  }
}
