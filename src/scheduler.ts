import type { Logging } from 'homebridge';

import type { ScheduleEntry, WeekDay, Zone } from './types';

const WEEKDAYS: readonly WeekDay[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface SchedulerOptions {
  /**
   * Called when the scheduler decides a zone should start. Resolves once the
   * underlying valve (and pump pre-run, if any) has come up. Errors are caught
   * and logged — they do not crash the scheduler.
   */
  startZone: (zoneId: string, durationMs: number) => Promise<void>;
  /**
   * Called when a zone's scheduled duration elapses. Resolves once the valve
   * has been closed. Errors are caught and logged.
   */
  stopZone: (zoneId: string) => Promise<void>;
  /**
   * Optional weather-block check. When the scheduler is about to enqueue a
   * zone and this returns true, the zone is skipped (logged, not queued).
   * The platform layer wires this to the blocking engine.
   */
  isZoneBlocked?: (zoneId: string) => boolean;
  /**
   * Optional notifier fired when {@link setActive} changes state or
   * {@link tick} fires an entry. Lets the platform persist state without
   * polling.
   */
  onStateChange?: () => void;
  /** Injectable clock; defaults to `() => new Date()`. */
  nowFn?: () => Date;
  log?: Logging;
}

interface PendingZoneRun {
  zoneId: string;
  durationMs: number;
  entryId: string;
  enqueuedAt: number;
}

/**
 * Schedule engine.
 *
 * Tick-driven: the platform calls {@link tick} on a short interval (e.g. every
 * 30 s) and the scheduler fires any entries whose start time has just passed
 * on a day they're configured for, exactly once per local day.
 *
 * Concurrency rules (from the spec):
 * - Zones in the same concurrency group may run together.
 * - Zones without a group (or with mismatched groups) cannot run together —
 *   they're serialised through an internal queue, with conflicts logged.
 *
 * The scheduler is also "restart-safe": when {@link setActive} is called and
 * the scheduler transitions from inactive to active, every entry whose start
 * time has already passed today is marked as if it had already fired, so
 * Homebridge coming back online mid-day never replays the morning's watering.
 *
 * Toggling the scheduler off does **not** stop zones that are already running
 * — the user can close those valves manually from Apple Home. Off only blocks
 * future scheduled starts.
 */
export class Scheduler {
  private active = false;
  private entries: ScheduleEntry[] = [];
  private zonesById = new Map<string, Zone>();
  private readonly firedToday = new Map<string, string>();
  private readonly queue: PendingZoneRun[] = [];
  private readonly activeRuns = new Map<string, NodeJS.Timeout>();

  private readonly startZoneCb: (zoneId: string, durationMs: number) => Promise<void>;
  private readonly stopZoneCb: (zoneId: string) => Promise<void>;
  private readonly isZoneBlockedCb: ((zoneId: string) => boolean) | undefined;
  private readonly onStateChangeCb: (() => void) | undefined;
  private readonly nowFn: () => Date;
  private readonly log: Logging | undefined;

  public constructor(options: SchedulerOptions) {
    this.startZoneCb = options.startZone;
    this.stopZoneCb = options.stopZone;
    this.isZoneBlockedCb = options.isZoneBlocked;
    this.onStateChangeCb = options.onStateChange;
    this.nowFn = options.nowFn ?? ((): Date => new Date());
    this.log = options.log;
  }

  /** Replace the zone roster. Concurrency lookups use this table. */
  public setZones(zones: Zone[]): void {
    this.zonesById = new Map(zones.map((z) => [z.id, z]));
  }

  /** Replace the schedule. Pending fires for the day are preserved across this call. */
  public setEntries(entries: ScheduleEntry[]): void {
    this.entries = entries;
  }

  /**
   * Toggle the scheduler. When activating, every entry whose start time has
   * already passed today is marked as already fired — so we never replay the
   * morning's watering after a mid-day restart or reactivation.
   */
  public setActive(active: boolean): void {
    const wasActive = this.active;
    this.active = active;
    if (active && !wasActive) {
      const now = this.nowFn();
      const dateKey = formatDateKey(now);
      const nowMinutes = hhmmToMinutes(formatHHMM(now));
      for (const entry of this.entries) {
        // Strictly before now: a late entry (Homebridge restart, etc.) — suppress it.
        // Equal to now: still its scheduled moment — let `tick` fire it normally.
        if (hhmmToMinutes(entry.startTime) < nowMinutes) {
          this.firedToday.set(entry.id, dateKey);
        }
      }
      this.log?.info(
        'Scheduler activated; %d entries already past for today',
        this.firedToday.size,
      );
      this.onStateChangeCb?.();
    } else if (!active && wasActive) {
      this.log?.info('Scheduler deactivated; running zones will finish their duration');
      this.onStateChangeCb?.();
    }
  }

  public isActive(): boolean {
    return this.active;
  }

  /**
   * Evaluate the schedule against the current time. Fires every entry that:
   * - is scheduled for today's weekday,
   * - has a start time at or before `now`, and
   * - has not already fired today.
   *
   * Called periodically by the platform; safe to call frequently.
   */
  public tick(now: Date = this.nowFn()): void {
    if (!this.active) {
      return;
    }
    const today = WEEKDAYS[now.getDay()];
    if (today === undefined) {
      return;
    }
    const dateKey = formatDateKey(now);
    const nowMinutes = hhmmToMinutes(formatHHMM(now));

    for (const entry of this.entries) {
      if (!entry.days.includes(today)) {
        continue;
      }
      if (this.firedToday.get(entry.id) === dateKey) {
        continue;
      }
      if (hhmmToMinutes(entry.startTime) > nowMinutes) {
        continue;
      }
      this.firedToday.set(entry.id, dateKey);
      this.fireEntry(entry, now);
      this.onStateChangeCb?.();
    }
  }

  /**
   * Restore the per-entry "fired today" map from persistent state. Stale
   * entries (date keys older than today) are dropped so they don't suppress
   * legitimate firings.
   */
  public restoreFiredToday(map: Record<string, string>, now: Date = this.nowFn()): void {
    const today = formatDateKey(now);
    this.firedToday.clear();
    for (const [entryId, dateKey] of Object.entries(map)) {
      if (dateKey === today) {
        this.firedToday.set(entryId, dateKey);
      }
    }
  }

  /** Snapshot the fired-today map for persistence. */
  public getFiredTodaySnapshot(): Record<string, string> {
    return Object.fromEntries(this.firedToday);
  }

  /** Zones currently watering (started, not yet finished). */
  public getActiveZones(): string[] {
    return [...this.activeRuns.keys()];
  }

  /** Zones queued behind concurrency conflicts. */
  public getQueuedZones(): string[] {
    return this.queue.map((q) => q.zoneId);
  }

  /**
   * Cancel everything: clears the queue, stops active runs by calling
   * `stopZone` immediately for each. Intended for shutdown hooks.
   */
  public async stopAll(): Promise<void> {
    this.queue.length = 0;
    const zoneIds = [...this.activeRuns.keys()];
    for (const id of zoneIds) {
      const timer = this.activeRuns.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.activeRuns.delete(id);
    }
    await Promise.allSettled(zoneIds.map((id) => this.stopZoneCb(id)));
  }

  private fireEntry(entry: ScheduleEntry, now: Date): void {
    this.log?.info(
      'Schedule entry "%s" firing at %s for %d zone(s)',
      entry.name,
      formatHHMM(now),
      entry.zoneIds.length,
    );
    const durationMs = entry.durationMin * 60 * 1000;
    for (const zoneId of entry.zoneIds) {
      if (!this.zonesById.has(zoneId)) {
        this.log?.warn('Entry "%s" references unknown zone %s — skipping', entry.name, zoneId);
        continue;
      }
      if (this.isZoneBlockedCb?.(zoneId) === true) {
        this.log?.info('Zone %s skipped: currently weather-blocked', zoneId);
        continue;
      }
      this.queue.push({ zoneId, durationMs, entryId: entry.id, enqueuedAt: now.getTime() });
    }
    this.tryStartAll();
    for (const run of this.queue) {
      if (run.entryId === entry.id) {
        this.log?.info('Zone %s queued behind active zone(s) due to concurrency rules', run.zoneId);
      }
    }
  }

  private tryStartAll(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i++) {
        const run = this.queue[i];
        if (run === undefined) {
          continue;
        }
        if (this.canRunWithCurrent(run.zoneId)) {
          this.queue.splice(i, 1);
          this.startRun(run);
          progressed = true;
          break;
        }
      }
    }
  }

  private canRunWithCurrent(zoneId: string): boolean {
    if (this.activeRuns.size === 0) {
      return true;
    }
    const zone = this.zonesById.get(zoneId);
    const group = zone?.concurrencyGroup;
    if (group === undefined || group === '') {
      return false; // standalone cannot join a non-empty active set
    }
    for (const activeId of this.activeRuns.keys()) {
      const activeZone = this.zonesById.get(activeId);
      if (activeZone?.concurrencyGroup !== group) {
        return false;
      }
    }
    return true;
  }

  private startRun(run: PendingZoneRun): void {
    this.log?.info('Starting zone %s for %d s', run.zoneId, run.durationMs / 1000);
    const timer = setTimeout(() => {
      void this.finishRun(run.zoneId);
    }, run.durationMs);
    this.activeRuns.set(run.zoneId, timer);
    void this.startZoneCb(run.zoneId, run.durationMs).catch((err: unknown) => {
      this.log?.error('startZone(%s) failed: %s', run.zoneId, String(err));
      this.cancelRun(run.zoneId);
    });
  }

  private async finishRun(zoneId: string): Promise<void> {
    this.activeRuns.delete(zoneId);
    try {
      await this.stopZoneCb(zoneId);
    } catch (err) {
      this.log?.error('stopZone(%s) failed: %s', zoneId, String(err));
    }
    this.tryStartAll();
  }

  private cancelRun(zoneId: string): void {
    const timer = this.activeRuns.get(zoneId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.activeRuns.delete(zoneId);
    this.tryStartAll();
  }
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((p) => Number.parseInt(p, 10));
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    return Number.POSITIVE_INFINITY;
  }
  return h * 60 + m;
}

function formatHHMM(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
