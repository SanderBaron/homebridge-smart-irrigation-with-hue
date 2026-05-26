import { Scheduler } from '../src/scheduler';
import type { ScheduleEntry, Zone } from '../src/types';

afterEach(() => {
  // Cancel any fake-timer setTimeouts the scheduler left behind (e.g. multi-
  // minute zone duration timers) before switching back to real timers, so the
  // jest worker exits cleanly.
  jest.clearAllTimers();
  jest.useRealTimers();
});

// Two zones that explicitly list each other as run-with buddies — they may
// run simultaneously.
const ZONE_LP_A: Zone = {
  id: 'lpA',
  name: 'Low-pressure A',
  type: 'dripLine',
  hueLightId: '1',
  runWith: ['lpB'],
};

const ZONE_LP_B: Zone = {
  id: 'lpB',
  name: 'Low-pressure B',
  type: 'dripLine',
  hueLightId: '2',
  runWith: ['lpA'],
};

// Standalone — empty runWith, can only run alone.
const ZONE_STANDALONE: Zone = {
  id: 'solo',
  name: 'Solo zone',
  type: 'sprinkler',
  hueLightId: '3',
};

// Another standalone (also incompatible with lp* — does not list them).
const ZONE_HP: Zone = {
  id: 'hp',
  name: 'High-pressure',
  type: 'sprinkler',
  hueLightId: '4',
};

// Drip line that joins every sprinkler — the asymmetric case the runWith
// model can express but a single concurrency group can't.
const ZONE_DRIP: Zone = {
  id: 'drip',
  name: 'Drip line',
  type: 'dripLine',
  hueLightId: '5',
};
const ZONE_SPR_1: Zone = {
  id: 'spr1',
  name: 'Sprinkler 1',
  type: 'sprinkler',
  hueLightId: '6',
  runWith: ['drip'],
};
const ZONE_SPR_2: Zone = {
  id: 'spr2',
  name: 'Sprinkler 2',
  type: 'sprinkler',
  hueLightId: '7',
  runWith: ['drip'],
};

// 2026-05-26 is a Tuesday.
const TUESDAY_0759 = new Date(2026, 4, 26, 7, 59, 0);
const TUESDAY_0800 = new Date(2026, 4, 26, 8, 0, 0);
const TUESDAY_0801 = new Date(2026, 4, 26, 8, 1, 0);
const WEDNESDAY_0800 = new Date(2026, 4, 27, 8, 0, 0);

function makeScheduler(now: Date): {
  scheduler: Scheduler;
  startZone: jest.Mock;
  stopZone: jest.Mock;
  setNow: (d: Date) => void;
} {
  let currentNow = now;
  const startZone = jest.fn().mockResolvedValue(undefined);
  const stopZone = jest.fn().mockResolvedValue(undefined);
  const scheduler = new Scheduler({
    startZone,
    stopZone,
    nowFn: () => currentNow,
  });
  return {
    scheduler,
    startZone,
    stopZone,
    setNow: (d) => {
      currentNow = d;
    },
  };
}

const ENTRY_TUE_0800_LP: ScheduleEntry = {
  id: 'e1',
  name: 'Morning low-pressure',
  days: ['Tue'],
  startTime: '08:00',
  durationMin: 10,
  zoneIds: ['lpA', 'lpB'],
};

describe('Scheduler — day and time filtering', () => {
  it('does not fire when inactive', () => {
    const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
    scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
    scheduler.setEntries([ENTRY_TUE_0800_LP]);
    scheduler.tick();
    expect(startZone).not.toHaveBeenCalled();
  });

  it('does not fire before start time', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone, setNow } = makeScheduler(TUESDAY_0759);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(startZone).not.toHaveBeenCalled();

      setNow(TUESDAY_0800);
      scheduler.tick();
      expect(startZone).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fire on a non-matching day', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(WEDNESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(startZone).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fires once per day even across many ticks', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();
      scheduler.tick();
      scheduler.tick();
      expect(startZone).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fire late entries on mid-day activation', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0801);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(startZone).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Scheduler — concurrency', () => {
  it('runs mutually-listed run-with buddies simultaneously', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(startZone).toHaveBeenCalledTimes(2);
      expect(startZone).toHaveBeenCalledWith('lpA', 10 * 60 * 1000);
      expect(startZone).toHaveBeenCalledWith('lpB', 10 * 60 * 1000);
      expect(scheduler.getActiveZones().sort()).toEqual(['lpA', 'lpB']);
      expect(scheduler.getQueuedZones()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues zones that do not list each other as run-with', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone, stopZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_HP]);
      const mixed: ScheduleEntry = {
        ...ENTRY_TUE_0800_LP,
        zoneIds: ['lpA', 'hp'],
      };
      scheduler.setEntries([mixed]);
      scheduler.setActive(true);
      scheduler.tick();

      // First zone in entry order starts; second is queued behind it.
      expect(startZone).toHaveBeenCalledTimes(1);
      expect(scheduler.getActiveZones()).toEqual(['lpA']);
      expect(scheduler.getQueuedZones()).toEqual(['hp']);

      // After lpA's duration elapses, hp should pick up.
      jest.advanceTimersByTime(10 * 60 * 1000);
      return Promise.resolve().then(() => {
        expect(stopZone).toHaveBeenCalledWith('lpA');
        expect(startZone).toHaveBeenCalledWith('hp', 10 * 60 * 1000);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks a standalone zone from joining an active zone with no relationship', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_STANDALONE]);
      const entry: ScheduleEntry = {
        ...ENTRY_TUE_0800_LP,
        zoneIds: ['lpA', 'solo'],
      };
      scheduler.setEntries([entry]);
      scheduler.setActive(true);
      scheduler.tick();

      expect(startZone).toHaveBeenCalledTimes(1);
      expect(scheduler.getActiveZones()).toEqual(['lpA']);
      expect(scheduler.getQueuedZones()).toEqual(['solo']);
    } finally {
      jest.useRealTimers();
    }
  });

  it("expands an entry with each zone's run-with buddies", () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_DRIP, ZONE_SPR_1]);
      const entry: ScheduleEntry = { ...ENTRY_TUE_0800_LP, zoneIds: ['spr1'] };
      scheduler.setEntries([entry]);
      scheduler.setActive(true);
      scheduler.tick();

      // The entry only lists spr1, but spr1.runWith pulls in drip too.
      expect(startZone).toHaveBeenCalledTimes(2);
      expect(scheduler.getActiveZones().sort()).toEqual(['drip', 'spr1']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asymmetric drip-with-every-sprinkler case: serialises sprinklers, drip rides along', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, stopZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_DRIP, ZONE_SPR_1, ZONE_SPR_2]);
      const e1: ScheduleEntry = {
        ...ENTRY_TUE_0800_LP,
        id: 'e1',
        zoneIds: ['spr1'],
        durationMin: 1,
      };
      const e2: ScheduleEntry = {
        ...ENTRY_TUE_0800_LP,
        id: 'e2',
        zoneIds: ['spr2'],
        durationMin: 1,
      };
      scheduler.setEntries([e1, e2]);
      scheduler.setActive(true);
      scheduler.tick();

      // e1 starts: spr1 + drip running together. spr2 + drip from e2 both
      // queue behind spr1 (drip can't double-start, spr2 conflicts with spr1).
      expect(scheduler.getActiveZones().sort()).toEqual(['drip', 'spr1']);
      expect(scheduler.getQueuedZones()).toContain('spr2');

      // After spr1 + drip finish, spr2 + drip start.
      await jest.advanceTimersByTimeAsync(60 * 1000);
      expect(stopZone).toHaveBeenCalledWith('spr1');
      expect(stopZone).toHaveBeenCalledWith('drip');
      expect(scheduler.getActiveZones().sort()).toEqual(['drip', 'spr2']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts compatible zones from a later entry that overlaps in time', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      const e1: ScheduleEntry = { ...ENTRY_TUE_0800_LP, zoneIds: ['lpA'] };
      const e2: ScheduleEntry = { ...ENTRY_TUE_0800_LP, id: 'e2', zoneIds: ['lpB'] };
      scheduler.setEntries([e1, e2]);
      scheduler.setActive(true);
      scheduler.tick();

      // Both compatible — both running.
      expect(scheduler.getActiveZones().sort()).toEqual(['lpA', 'lpB']);
      expect(startZone).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Scheduler — duration timer', () => {
  it('stops a zone after its configured duration', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, stopZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A]);
      scheduler.setEntries([{ ...ENTRY_TUE_0800_LP, zoneIds: ['lpA'], durationMin: 1 }]);
      scheduler.setActive(true);
      scheduler.tick();

      expect(stopZone).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60 * 1000);
      expect(stopZone).toHaveBeenCalledWith('lpA');
      expect(scheduler.getActiveZones()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Scheduler — weather block hook', () => {
  it('skips weather-blocked zones (not queued, not started)', () => {
    jest.useFakeTimers();
    try {
      const startZone = jest.fn().mockResolvedValue(undefined);
      const stopZone = jest.fn().mockResolvedValue(undefined);
      const isZoneBlocked = jest.fn((id: string) => id === 'lpA');
      const scheduler = new Scheduler({
        startZone,
        stopZone,
        isZoneBlocked,
        nowFn: () => TUESDAY_0800,
      });
      scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
      scheduler.setEntries([ENTRY_TUE_0800_LP]);
      scheduler.setActive(true);
      scheduler.tick();

      expect(startZone).toHaveBeenCalledTimes(1);
      expect(startZone).toHaveBeenCalledWith('lpB', expect.any(Number));
      expect(scheduler.getQueuedZones()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Scheduler — unknown zone reference', () => {
  it('skips entries pointing to a zone that no longer exists', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A]);
      scheduler.setEntries([{ ...ENTRY_TUE_0800_LP, zoneIds: ['lpA', 'gone'] }]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(startZone).toHaveBeenCalledTimes(1);
      expect(startZone).toHaveBeenCalledWith('lpA', expect.any(Number));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Scheduler — restoreFiredToday', () => {
  it('keeps entries whose date matches today and drops stale ones', () => {
    const { scheduler, startZone } = makeScheduler(TUESDAY_0800);
    scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
    scheduler.setEntries([ENTRY_TUE_0800_LP]);
    scheduler.restoreFiredToday({ e1: '2026-05-26', stale: '2026-05-20' }, TUESDAY_0800);
    scheduler.setActive(true);
    scheduler.tick();
    // Entry e1 was marked fired-today, so it must not re-fire even though
    // the clock matches its start time.
    expect(startZone).not.toHaveBeenCalled();
    expect(scheduler.getFiredTodaySnapshot()).toEqual({ e1: '2026-05-26' });
  });
});

describe('Scheduler — onStateChange', () => {
  it('fires when setActive flips and when an entry tick fires', () => {
    const onStateChange = jest.fn();
    const startZone = jest.fn().mockResolvedValue(undefined);
    const stopZone = jest.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler({
      startZone,
      stopZone,
      onStateChange,
      nowFn: () => TUESDAY_0800,
    });
    scheduler.setZones([ZONE_LP_A, ZONE_LP_B]);
    scheduler.setEntries([ENTRY_TUE_0800_LP]);
    scheduler.setActive(true);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    scheduler.tick();
    expect(onStateChange).toHaveBeenCalledTimes(2);
    scheduler.setActive(false);
    expect(onStateChange).toHaveBeenCalledTimes(3);
  });
});

describe('Scheduler — stopAll', () => {
  it('clears queue and stops running zones', async () => {
    jest.useFakeTimers();
    try {
      const { scheduler, stopZone } = makeScheduler(TUESDAY_0800);
      scheduler.setZones([ZONE_LP_A, ZONE_HP]);
      scheduler.setEntries([{ ...ENTRY_TUE_0800_LP, zoneIds: ['lpA', 'hp'] }]);
      scheduler.setActive(true);
      scheduler.tick();
      expect(scheduler.getActiveZones()).toEqual(['lpA']);
      expect(scheduler.getQueuedZones()).toEqual(['hp']);

      await scheduler.stopAll();
      expect(scheduler.getActiveZones()).toEqual([]);
      expect(scheduler.getQueuedZones()).toEqual([]);
      expect(stopZone).toHaveBeenCalledWith('lpA');
    } finally {
      jest.useRealTimers();
    }
  });
});
