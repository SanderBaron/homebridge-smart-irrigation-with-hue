import type { Logging } from 'homebridge';

import type { PumpConfig } from './types';

export interface PumpOrchestratorOptions {
  config: PumpConfig;
  /**
   * Hardware bridge: callable that toggles the pump socket. The orchestrator
   * is decoupled from the Hue client so it can be unit-tested without any
   * network calls — the platform layer will pass `(on) => hueClient.setLightOn(config.hueLightId, on)`.
   */
  setPumpState: (on: boolean) => Promise<void>;
  log?: Logging;
}

/**
 * Tracks which zones currently need pump pressure and toggles the pump socket
 * accordingly. Implements two timing requirements from the spec:
 *
 * - **pre-run** — when the first zone in coverage starts, the pump runs for
 *   `preRunSec` before {@link requestPumpStart} resolves, so the caller can
 *   open the valve against built-up pressure.
 * - **post-run** — when the last covered zone stops, the pump keeps running
 *   for `postRunSec` to bleed pressure off the lines, then shuts off. If a
 *   new zone request arrives during the post-run window, the shutdown is
 *   cancelled and the pump stays on continuously.
 *
 * v1 supports a single pump. Multi-pump support is on the roadmap.
 */
export class PumpOrchestrator {
  private readonly config: PumpConfig;
  private readonly setPumpState: (on: boolean) => Promise<void>;
  private readonly log: Logging | undefined;
  private readonly activeZones = new Set<string>();
  private readonly coverage: Set<string> | null;
  private pumpOn = false;
  private shutdownTimer: NodeJS.Timeout | undefined;
  private startupInProgress: Promise<void> | undefined;

  public constructor(options: PumpOrchestratorOptions) {
    this.config = options.config;
    this.setPumpState = options.setPumpState;
    this.log = options.log;
    // An explicit allow-list is converted to a Set for O(1) membership; an
    // empty list is normalised to `null` meaning "covers all zones".
    this.coverage = options.config.zoneIds.length === 0 ? null : new Set(options.config.zoneIds);
  }

  /**
   * Register a zone as wanting pump pressure. Resolves once the pump is on and
   * (if this was the first active zone) the pre-run delay has elapsed.
   *
   * No-ops when the pump is disabled or the zone is not in the coverage list.
   */
  public async requestPumpStart(zoneId: string): Promise<void> {
    if (!this.isCovered(zoneId)) {
      return;
    }

    // A pending shutdown from a previous "last zone stopped" event is now stale.
    this.cancelPendingShutdown();
    this.activeZones.add(zoneId);

    if (this.pumpOn) {
      return;
    }

    if (this.startupInProgress !== undefined) {
      // Another concurrent caller is already starting the pump — share its work.
      await this.startupInProgress;
      return;
    }

    const startup = this.runStartup();
    this.startupInProgress = startup;
    try {
      await startup;
    } finally {
      if (this.startupInProgress === startup) {
        this.startupInProgress = undefined;
      }
    }
  }

  /**
   * Release a zone's claim on the pump. If this was the last active zone,
   * schedules the pump to shut off after `postRunSec`. Synchronous — the
   * actual pump-off happens later in the timer callback.
   */
  public releasePumpStop(zoneId: string): void {
    if (!this.activeZones.delete(zoneId)) {
      return;
    }
    if (this.activeZones.size > 0) {
      return;
    }

    this.cancelPendingShutdown();
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = undefined;
      this.runShutdown();
    }, this.config.postRunSec * 1000);
  }

  /** Whether the pump socket is currently on (post-pre-run completed). */
  public isPumpOn(): boolean {
    return this.pumpOn;
  }

  /** Number of zones currently holding the pump on. */
  public activeZoneCount(): number {
    return this.activeZones.size;
  }

  /**
   * Stop any pending shutdown and force the pump off immediately. Intended for
   * shutdown hooks (Homebridge stop event, bridge disconnect, panic abort).
   */
  public async forceStop(): Promise<void> {
    this.cancelPendingShutdown();
    this.activeZones.clear();
    if (this.pumpOn) {
      await this.invokeSetPumpState(false);
      this.pumpOn = false;
    }
  }

  private isCovered(zoneId: string): boolean {
    if (!this.config.enabled) {
      return false;
    }
    return this.coverage === null || this.coverage.has(zoneId);
  }

  private async runStartup(): Promise<void> {
    this.log?.info('Pump pre-run: powering on for %ds', this.config.preRunSec);
    await this.invokeSetPumpState(true);
    this.pumpOn = true;
    if (this.config.preRunSec > 0) {
      await delay(this.config.preRunSec * 1000);
    }
  }

  private runShutdown(): void {
    this.log?.info('Pump post-run elapsed: powering off');
    void this.invokeSetPumpState(false)
      .then(() => {
        this.pumpOn = false;
      })
      .catch((err: unknown) => {
        // Shutdown errors are logged and swallowed: there is nobody upstream
        // waiting on this promise, and re-throwing would crash the timer tick.
        this.log?.error('Failed to power pump off: %s', String(err));
      });
  }

  private cancelPendingShutdown(): void {
    if (this.shutdownTimer !== undefined) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
  }

  private async invokeSetPumpState(on: boolean): Promise<void> {
    await this.setPumpState(on);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
