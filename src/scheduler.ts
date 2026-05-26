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
  /**
   * Optional notifier fired when a manually-triggered run (via
   * {@link runAllEntriesNow}) starts or finishes. Lets the platform reflect
   * the state of the "Run Schedule Now" switch in Apple Home.
   */
  onManualRunStateChange?: (active: boolean) => void;
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
 * Bookkeeping for an entry currently working its way through its `steps[]`
 * sequence. The scheduler enqueues exactly one step at a time (the current
 * one); when its zone's `finishRun` fires, we advance the step index and
 * enqueue the next one, looping per `entry.repeat`.
 */
interface ActiveSequence {
  entryId: string;
  entry: ScheduleEntry;
  /** 0-indexed repeat count. Entry done when this reaches `entry.repeat`. */
  repeatIndex: number;
  /** 0-indexed step within the current repeat. */
  stepIndex: number;
  /** The zoneId currently running for this sequence's step (cleared on advance). */
  runningZoneId: string | undefined;
  /**
   * True when this sequence was started by {@link runAllEntriesNow} (the
   * "Run Schedule Now" switch). Lets the platform light up that switch
   * only while the manual run is in progress.
   */
  manuallyTriggered: boolean;
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
  private readonly activeSequences: ActiveSequence[] = [];

  private readonly startZoneCb: (zoneId: string, durationMs: number) => Promise<void>;
  private readonly stopZoneCb: (zoneId: string) => Promise<void>;
  private readonly isZoneBlockedCb: ((zoneId: string) => boolean) | undefined;
  private readonly onStateChangeCb: (() => void) | undefined;
  private readonly onManualRunStateChangeCb: ((active: boolean) => void) | undefined;
  private readonly nowFn: () => Date;
  private readonly log: Logging | undefined;
  private lastManualRunActive = false;

  public constructor(options: SchedulerOptions) {
    this.startZoneCb = options.startZone;
    this.stopZoneCb = options.stopZone;
    this.isZoneBlockedCb = options.isZoneBlocked;
    this.onStateChangeCb = options.onStateChange;
    this.onManualRunStateChangeCb = options.onManualRunStateChange;
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

  /**
   * Run every configured schedule entry right now, regardless of the day or
   * start time. Intended for the "Run Schedule Now" switch in Apple Home.
   * Respects weather blocking, the run-with model, and concurrency just like
   * a normal scheduled fire. The created sequences are tagged as manually
   * triggered so the switch in Apple Home can light up only while *this*
   * run is in progress.
   */
  public runAllEntriesNow(): void {
    const now = this.nowFn();
    if (this.entries.length === 0) {
      this.log?.info('Run-now requested but no schedule entries are configured.');
      return;
    }
    this.log?.info('Run-now triggered for %d schedule entries', this.entries.length);
    for (const entry of this.entries) {
      const seq: ActiveSequence = {
        entryId: entry.id,
        entry,
        repeatIndex: 0,
        stepIndex: 0,
        runningZoneId: undefined,
        manuallyTriggered: true,
      };
      this.activeSequences.push(seq);
      this.advanceSequence(seq, now.getTime());
    }
    this.notifyManualRunState();
  }

  /** True if any sequence started via `runAllEntriesNow` is still in progress. */
  public hasActiveManualRun(): boolean {
    return this.activeSequences.some((s) => s.manuallyTriggered);
  }

  private notifyManualRunState(): void {
    const active = this.hasActiveManualRun();
    if (active !== this.lastManualRunActive) {
      this.lastManualRunActive = active;
      this.onManualRunStateChangeCb?.(active);
    }
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
    this.activeSequences.length = 0;
    const zoneIds = [...this.activeRuns.keys()];
    for (const id of zoneIds) {
      const timer = this.activeRuns.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.activeRuns.delete(id);
    }
    this.notifyManualRunState();
    await Promise.allSettled(zoneIds.map((id) => this.stopZoneCb(id)));
  }

  private fireEntry(entry: ScheduleEntry, now: Date): void {
    if (entry.steps.length === 0) {
      return;
    }
    this.log?.info(
      'Schedule entry "%s" firing at %s — %d step(s) × %d repeat(s)',
      entry.name,
      formatHHMM(now),
      entry.steps.length,
      entry.repeat,
    );
    const seq: ActiveSequence = {
      entryId: entry.id,
      entry,
      repeatIndex: 0,
      stepIndex: 0,
      runningZoneId: undefined,
      manuallyTriggered: false,
    };
    this.activeSequences.push(seq);
    this.advanceSequence(seq, now.getTime());
  }

  /**
   * Enqueue the sequence's current step's zone, or finish the sequence if
   * every repeat is done. Called when an entry first fires and after each
   * step's zone completes.
   */
  private advanceSequence(seq: ActiveSequence, enqueuedAt: number): void {
    while (seq.repeatIndex < seq.entry.repeat) {
      if (seq.stepIndex >= seq.entry.steps.length) {
        seq.repeatIndex += 1;
        seq.stepIndex = 0;
        continue;
      }
      const step = seq.entry.steps[seq.stepIndex];
      if (step === undefined) {
        seq.stepIndex += 1;
        continue;
      }
      if (!this.zonesById.has(step.zoneId)) {
        this.log?.warn(
          'Entry "%s" step %d references unknown zone %s — skipping',
          seq.entry.name,
          seq.stepIndex,
          step.zoneId,
        );
        seq.stepIndex += 1;
        continue;
      }
      if (this.isZoneBlockedCb?.(step.zoneId) === true) {
        this.log?.info(
          'Entry "%s" step %d zone %s skipped: weather-blocked',
          seq.entry.name,
          seq.stepIndex,
          step.zoneId,
        );
        seq.stepIndex += 1;
        continue;
      }
      seq.runningZoneId = step.zoneId;
      this.queue.push({
        zoneId: step.zoneId,
        durationMs: step.durationMin * 60 * 1000,
        entryId: seq.entryId,
        enqueuedAt,
      });
      this.tryStartAll();
      return;
    }
    // All repeats exhausted — remove sequence.
    this.log?.info('Schedule entry "%s" sequence complete', seq.entry.name);
    const idx = this.activeSequences.indexOf(seq);
    if (idx !== -1) {
      this.activeSequences.splice(idx, 1);
    }
    this.notifyManualRunState();
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
    for (const activeId of this.activeRuns.keys()) {
      if (!this.areCompatible(zoneId, activeId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Two zones may run simultaneously iff at least one of them lists the other
   * in its `runWith` array. The relationship is one-directional in storage
   * but symmetric in effect — if A's runWith includes B, A and B can coexist
   * regardless of what B's runWith says.
   */
  private areCompatible(zoneIdA: string, zoneIdB: string): boolean {
    if (zoneIdA === zoneIdB) {
      return true;
    }
    const a = this.zonesById.get(zoneIdA);
    const b = this.zonesById.get(zoneIdB);
    if (a?.runWith?.includes(zoneIdB)) {
      return true;
    }
    if (b?.runWith?.includes(zoneIdA)) {
      return true;
    }
    return false;
  }

  private startRun(run: PendingZoneRun): void {
    const wasActive = this.activeRuns.has(run.zoneId);
    const existingTimer = this.activeRuns.get(run.zoneId);
    if (existingTimer !== undefined) {
      // Buddy was already running — clear its old timer so we don't stop it
      // prematurely; the new timer below extends the run.
      clearTimeout(existingTimer);
    }

    const action = wasActive ? 'extending zone' : 'starting zone';
    this.log?.info('%s %s for %d s', action, run.zoneId, run.durationMs / 1000);

    const timer = setTimeout(() => {
      void this.finishRun(run.zoneId);
    }, run.durationMs);
    this.activeRuns.set(run.zoneId, timer);

    if (!wasActive) {
      void this.startZoneCb(run.zoneId, run.durationMs).catch((err: unknown) => {
        this.log?.error('startZone(%s) failed: %s', run.zoneId, String(err));
        this.cancelRun(run.zoneId);
      });
    }

    // Lazy run-with expansion: pull in each buddy zone now that the trigger
    // zone is actually starting fresh. We skip expansion on extension
    // (wasActive) so two mutually-listed zones don't endlessly re-push each
    // other into the queue. A later entry's fresh start will re-push and
    // extend the buddy's timer as needed (handles the drip-rides-along case).
    if (!wasActive) {
      const zone = this.zonesById.get(run.zoneId);
      for (const buddyId of zone?.runWith ?? []) {
        if (!this.zonesById.has(buddyId)) {
          continue;
        }
        if (this.queue.some((q) => q.zoneId === buddyId)) {
          continue;
        }
        if (this.isZoneBlockedCb?.(buddyId) === true) {
          this.log?.info('Run-with buddy %s skipped: currently weather-blocked', buddyId);
          continue;
        }
        this.queue.push({
          zoneId: buddyId,
          durationMs: run.durationMs,
          entryId: run.entryId,
          enqueuedAt: run.enqueuedAt,
        });
      }
    }
  }

  /**
   * Synchronous: removes the zone from the active set, fires-and-forgets the
   * stopZone callback, advances any sequence whose current step matches this
   * zone, and immediately processes the queue. Synchronous is important — if
   * we awaited stopZone, another pending fake-timer could fire during the
   * microtask, racing us before tryStartAll cancels its timer via a run-with
   * extension.
   */
  private finishRun(zoneId: string): void {
    this.activeRuns.delete(zoneId);
    void this.stopZoneCb(zoneId).catch((err: unknown) => {
      this.log?.error('stopZone(%s) failed: %s', zoneId, String(err));
    });

    // Advance any sequence whose current step just finished. Run-with buddies
    // that finish do not advance the sequence — only the step's own zone does.
    const now = this.nowFn().getTime();
    const advancing = this.activeSequences.filter((s) => s.runningZoneId === zoneId);
    for (const seq of advancing) {
      seq.runningZoneId = undefined;
      seq.stepIndex += 1;
      this.advanceSequence(seq, now);
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
