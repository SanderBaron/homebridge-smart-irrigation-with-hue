import { OverrideManager } from '../src/overrideManager';

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('OverrideManager', () => {
  it('sets and clears overrides synchronously', () => {
    const mgr = new OverrideManager({ autoResetMinutes: 60 });
    expect(mgr.isOverridden('z1', 'wind')).toBe(false);
    mgr.setOverride('z1', 'wind', true);
    expect(mgr.isOverridden('z1', 'wind')).toBe(true);
    mgr.setOverride('z1', 'wind', false);
    expect(mgr.isOverridden('z1', 'wind')).toBe(false);
  });

  it('auto-resets after the configured timeout', () => {
    jest.useFakeTimers();
    const onChange = jest.fn();
    const mgr = new OverrideManager({ autoResetMinutes: 30, onChange });
    mgr.setOverride('z1', 'rain', true);
    expect(mgr.isOverridden('z1', 'rain')).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('z1', 'rain', true);

    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(mgr.isOverridden('z1', 'rain')).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith('z1', 'rain', false);
  });

  it('does not fire onChange when re-activating an already-active override (timer-renew only)', () => {
    jest.useFakeTimers();
    const onChange = jest.fn();
    const mgr = new OverrideManager({ autoResetMinutes: 30, onChange });
    mgr.setOverride('z1', 'wind', true);
    onChange.mockClear();
    mgr.setOverride('z1', 'wind', true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resets the timer when re-activated, so it stays active past the original deadline', () => {
    jest.useFakeTimers();
    const mgr = new OverrideManager({ autoResetMinutes: 10 });
    mgr.setOverride('z1', 'wind', true);
    jest.advanceTimersByTime(8 * 60 * 1000); // 80% through
    mgr.setOverride('z1', 'wind', true); // renew
    jest.advanceTimersByTime(5 * 60 * 1000); // past original deadline
    expect(mgr.isOverridden('z1', 'wind')).toBe(true);
  });

  it('tracks wind and rain independently for the same zone', () => {
    const mgr = new OverrideManager({ autoResetMinutes: 60 });
    mgr.setOverride('z1', 'wind', true);
    expect(mgr.isOverridden('z1', 'wind')).toBe(true);
    expect(mgr.isOverridden('z1', 'rain')).toBe(false);
  });

  it('clearAllSilent removes overrides without firing onChange', () => {
    jest.useFakeTimers();
    const onChange = jest.fn();
    const mgr = new OverrideManager({ autoResetMinutes: 60, onChange });
    mgr.setOverride('z1', 'wind', true);
    mgr.setOverride('z2', 'rain', true);
    onChange.mockClear();
    mgr.clearAllSilent();
    expect(mgr.isOverridden('z1', 'wind')).toBe(false);
    expect(mgr.isOverridden('z2', 'rain')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('listActive surfaces zone, kind, and expiresAt', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const mgr = new OverrideManager({ autoResetMinutes: 60 });
    mgr.setOverride('z1', 'rain', true);
    const list = mgr.listActive();
    expect(list).toHaveLength(1);
    expect(list[0]?.zoneId).toBe('z1');
    expect(list[0]?.kind).toBe('rain');
    expect(list[0]?.expiresAt).toBeGreaterThan(Date.now() - 1);
  });
});
