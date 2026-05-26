import type { Logging } from 'homebridge';

export type OverrideKind = 'wind' | 'rain';

export interface OverrideManagerOptions {
  /** Default duration after which an active override auto-clears. Per the spec, default 60. */
  autoResetMinutes: number;
  /**
   * Called whenever an override flips (manual or auto-reset). The platform
   * wires this to the Switch.On characteristic so HomeKit reflects the change
   * — including the auto-reset edge, which the user did not trigger.
   */
  onChange?: (zoneId: string, kind: OverrideKind, active: boolean) => void;
  log?: Logging;
}

interface ActiveOverride {
  zoneId: string;
  kind: OverrideKind;
  /** Timer scheduled to fire when the override auto-clears. */
  timer: NodeJS.Timeout;
  /** Wall-clock ms when the override expires. Useful for restored state. */
  expiresAt: number;
}

function key(zoneId: string, kind: OverrideKind): string {
  return `${kind}:${zoneId}`;
}

/**
 * Tracks the active state of per-zone manual override switches.
 *
 * Two kinds: `wind` lifts the wind-blocking veto, `rain` lifts the rain-skip
 * veto. Both auto-reset after `autoResetMinutes`. The blocking engine queries
 * {@link isOverridden} before treating a zone as blocked, and the platform
 * mirrors the state into the corresponding HomeKit Switch via {@link onChange}.
 *
 * Activating an already-active override resets its timer (so the user can
 * "renew" it from HomeKit without first toggling off).
 */
export class OverrideManager {
  private readonly active = new Map<string, ActiveOverride>();
  private autoResetMs: number;
  private readonly onChange:
    | ((zoneId: string, kind: OverrideKind, active: boolean) => void)
    | undefined;
  private readonly log: Logging | undefined;

  public constructor(options: OverrideManagerOptions) {
    this.autoResetMs = options.autoResetMinutes * 60 * 1000;
    this.onChange = options.onChange;
    this.log = options.log;
  }

  /** Set or clear an override. Setting an already-active one resets its timer. */
  public setOverride(zoneId: string, kind: OverrideKind, active: boolean): void {
    const k = key(zoneId, kind);
    const existing = this.active.get(k);
    if (!active) {
      if (existing !== undefined) {
        clearTimeout(existing.timer);
        this.active.delete(k);
        this.log?.info('%s override for %s cleared manually', kind, zoneId);
        this.onChange?.(zoneId, kind, false);
      }
      return;
    }

    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.active.delete(k);
      this.log?.info('%s override for %s auto-reset', kind, zoneId);
      this.onChange?.(zoneId, kind, false);
    }, this.autoResetMs);
    this.active.set(k, {
      zoneId,
      kind,
      timer,
      expiresAt: Date.now() + this.autoResetMs,
    });
    if (existing === undefined) {
      this.log?.info(
        '%s override for %s set; auto-reset in %d min',
        kind,
        zoneId,
        Math.round(this.autoResetMs / 60000),
      );
      this.onChange?.(zoneId, kind, true);
    }
  }

  /** Whether the given override is currently active. */
  public isOverridden(zoneId: string, kind: OverrideKind): boolean {
    return this.active.has(key(zoneId, kind));
  }

  /** Update the auto-reset window; takes effect on the next setOverride call. */
  public setAutoResetMinutes(minutes: number): void {
    this.autoResetMs = minutes * 60 * 1000;
  }

  /** Cancel every active override (no `onChange` events fired). Used during shutdown. */
  public clearAllSilent(): void {
    for (const override of this.active.values()) {
      clearTimeout(override.timer);
    }
    this.active.clear();
  }

  /** Inspect current overrides — primarily for tests and persistent-state snapshots. */
  public listActive(): Array<{ zoneId: string; kind: OverrideKind; expiresAt: number }> {
    return [...this.active.values()].map(({ zoneId, kind, expiresAt }) => ({
      zoneId,
      kind,
      expiresAt,
    }));
  }

  /**
   * Restore overrides from persisted state. Each entry schedules an auto-reset
   * timer for whatever time is left until its original `expiresAt`. Overrides
   * whose expiry is already in the past are dropped (no-op) — they would
   * fire instantly otherwise. `onChange` is not invoked during restore: this
   * is silent rehydration, not a user-triggered flip.
   */
  public restore(
    items: Array<{ zoneId: string; kind: OverrideKind; expiresAt: number }>,
    now: number = Date.now(),
  ): void {
    this.clearAllSilent();
    for (const item of items) {
      const remainingMs = item.expiresAt - now;
      if (remainingMs <= 0) {
        continue;
      }
      const timer = setTimeout(() => {
        this.active.delete(key(item.zoneId, item.kind));
        this.log?.info('%s override for %s auto-reset (restored)', item.kind, item.zoneId);
        this.onChange?.(item.zoneId, item.kind, false);
      }, remainingMs);
      this.active.set(key(item.zoneId, item.kind), {
        zoneId: item.zoneId,
        kind: item.kind,
        timer,
        expiresAt: item.expiresAt,
      });
    }
  }
}
