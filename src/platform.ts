import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { evaluateZoneBlocking } from './blockingEngine';
import { parseConfig, type SmartIrrigationConfig } from './config';
import { HueClient } from './hue/client';
import { OverrideManager } from './overrideManager';
import { PumpOrchestrator } from './pumpOrchestrator';
import { Scheduler } from './scheduler';
import { SmartIrrigationAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
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
 *   block / don't-block verdict, modulated by manual override switches.
 * - **Pump orchestrator** sequences pre-/post-run timing for the optional
 *   central pump.
 * - **Scheduler** fires schedule entries with concurrency-group awareness.
 * - **Override manager** tracks per-zone wind/rain override state with
 *   auto-reset.
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
  private overrideManager: OverrideManager | undefined;
  private weatherCache: TtlCache<WeatherSnapshot[]> | undefined;
  private accessoryBuilder: SmartIrrigationAccessory | undefined;
  private hueOnline = false;
  private readonly intervalTimers: NodeJS.Timeout[] = [];

  public constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Initializing %s platform', PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      this.bootstrap();
    });
    this.api.on('shutdown', () => {
      this.shutdown();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring accessory from cache: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  // ---------------- bootstrap ----------------

  private bootstrap(): void {
    const result = parseConfig(this.config);
    if (!result.ok) {
      this.log.error(
        'Configuration error — platform will not register accessories: %s',
        result.error,
      );
      return;
    }
    this.parsedConfig = result.config;

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
      log: this.log,
    });
    this.scheduler.setZones(result.config.zones);
    this.scheduler.setEntries(result.config.schedule);

    this.overrideManager = new OverrideManager({
      autoResetMinutes: result.config.override.autoResetMinutes,
      onChange: (zoneId, kind, active) => {
        this.accessoryBuilder?.syncOverrideSwitch(zoneId, kind, active);
      },
      log: this.log,
    });

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

    if (
      this.pump === undefined ||
      this.scheduler === undefined ||
      this.overrideManager === undefined
    ) {
      return;
    }

    this.accessoryBuilder = new SmartIrrigationAccessory(this, accessory, {
      config,
      hueClient: this.hueClient,
      pump: this.pump,
      scheduler: this.scheduler,
      overrideManager: this.overrideManager,
      isHueOnline: () => this.hueOnline,
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
      await this.weatherCache.getOrCompute(async () => this.fetchAllSources());
    } catch (err) {
      this.log.warn('Weather refresh failed: %s', String(err));
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
    if (this.parsedConfig === undefined || this.overrideManager === undefined) {
      return false;
    }
    const zone = this.parsedConfig.zones.find((z) => z.id === zoneId);
    if (zone === undefined) {
      return false;
    }
    const snapshots = this.weatherCache?.peek() ?? [];
    const decision = evaluateZoneBlocking(
      zone,
      snapshots,
      this.parsedConfig.weather.consensusStrategy,
    );

    const windOverridden = this.overrideManager.isOverridden(zoneId, 'wind');
    const rainOverridden = this.overrideManager.isOverridden(zoneId, 'rain');

    const windBlocking = decision.wind?.blocked === true && !windOverridden;
    const rainBlocking = decision.rain?.blocked === true && !rainOverridden;

    if (windBlocking || rainBlocking) {
      const reasons: string[] = [];
      if (windBlocking) {
        reasons.push(decision.wind?.explanation ?? 'wind');
      }
      if (rainBlocking) {
        reasons.push(decision.rain?.explanation ?? 'rain');
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

  // ---------------- shutdown ----------------

  private shutdown(): void {
    this.log.info('%s shutting down', PLATFORM_NAME);
    for (const t of this.intervalTimers) {
      clearInterval(t);
    }
    this.intervalTimers.length = 0;
    this.overrideManager?.clearAllSilent();
    void this.pump?.forceStop();
    void this.scheduler?.stopAll();
    void this.accessoryBuilder?.closeAllValves('shutdown');
  }
}
