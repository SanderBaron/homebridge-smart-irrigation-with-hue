import { PumpOrchestrator } from '../src/pumpOrchestrator';
import type { PumpConfig } from '../src/types';

const baseConfig: PumpConfig = {
  enabled: true,
  hueLightId: '99',
  preRunSec: 3,
  postRunSec: 5,
  zoneIds: [],
};

function makeOrchestrator(configOverrides: Partial<PumpConfig> = {}): {
  orch: PumpOrchestrator;
  setPumpState: jest.Mock<Promise<void>, [boolean]>;
} {
  const setPumpState = jest.fn<Promise<void>, [boolean]>().mockResolvedValue(undefined);
  const orch = new PumpOrchestrator({
    config: { ...baseConfig, ...configOverrides },
    setPumpState,
  });
  return { orch, setPumpState };
}

describe('PumpOrchestrator — disabled / out-of-coverage', () => {
  it('is a no-op when the pump is disabled', async () => {
    const { orch, setPumpState } = makeOrchestrator({ enabled: false });
    await orch.requestPumpStart('zoneA');
    orch.releasePumpStop('zoneA');
    expect(setPumpState).not.toHaveBeenCalled();
    expect(orch.isPumpOn()).toBe(false);
  });

  it('ignores zones outside the explicit coverage list', async () => {
    const { orch, setPumpState } = makeOrchestrator({ zoneIds: ['zoneA'] });
    await orch.requestPumpStart('zoneB');
    orch.releasePumpStop('zoneB');
    expect(setPumpState).not.toHaveBeenCalled();
  });

  it('treats an empty coverage list as "all zones"', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, zoneIds: [] });
      await orch.requestPumpStart('anything');
      expect(setPumpState).toHaveBeenCalledWith(true);
      expect(orch.isPumpOn()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('PumpOrchestrator — single zone lifecycle', () => {
  it('powers the pump on and waits the pre-run before resolving', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 3 });
      const started = orch.requestPumpStart('zoneA');
      let resolved = false;
      void started.then(() => {
        resolved = true;
      });

      // Flush microtasks: setPumpState(true) resolves, pumpOn flips to true,
      // then the pre-run delay begins via setTimeout.
      await jest.advanceTimersByTimeAsync(0);
      expect(setPumpState).toHaveBeenCalledWith(true);
      expect(orch.isPumpOn()).toBe(true);
      expect(resolved).toBe(false);

      // 1 ms short of the deadline — still not resolved.
      await jest.advanceTimersByTimeAsync(2999);
      expect(resolved).toBe(false);

      // Crossing the deadline resolves the promise.
      await jest.advanceTimersByTimeAsync(1);
      await started;
      expect(resolved).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules pump-off post-run after the last zone releases', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, postRunSec: 5 });
      await orch.requestPumpStart('zoneA');
      expect(setPumpState).toHaveBeenLastCalledWith(true);

      orch.releasePumpStop('zoneA');
      expect(setPumpState).toHaveBeenCalledTimes(1); // not off yet

      await jest.advanceTimersByTimeAsync(5000);
      expect(setPumpState).toHaveBeenLastCalledWith(false);
      expect(setPumpState).toHaveBeenCalledTimes(2);
      expect(orch.isPumpOn()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores releasePumpStop for unknown zones', () => {
    const { orch } = makeOrchestrator();
    expect(() => orch.releasePumpStop('never-started')).not.toThrow();
  });
});

describe('PumpOrchestrator — multi-zone overlap', () => {
  it('does not call setPumpState(true) twice when a second zone joins mid-run', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, postRunSec: 5 });
      await orch.requestPumpStart('zoneA');
      await orch.requestPumpStart('zoneB');
      expect(setPumpState).toHaveBeenCalledTimes(1);
      expect(orch.activeZoneCount()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the pump on while any zone is active', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, postRunSec: 5 });
      await orch.requestPumpStart('zoneA');
      await orch.requestPumpStart('zoneB');
      orch.releasePumpStop('zoneA');

      // Zone B is still active — no shutdown timer should be pending.
      await jest.advanceTimersByTimeAsync(10000);
      expect(setPumpState).toHaveBeenCalledTimes(1);
      expect(orch.isPumpOn()).toBe(true);

      orch.releasePumpStop('zoneB');
      await jest.advanceTimersByTimeAsync(5000);
      expect(setPumpState).toHaveBeenLastCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a pending shutdown when a new zone starts within the post-run window', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, postRunSec: 5 });
      await orch.requestPumpStart('zoneA');
      orch.releasePumpStop('zoneA');

      // Half-way through post-run, zone B requests the pump.
      await jest.advanceTimersByTimeAsync(2500);
      await orch.requestPumpStart('zoneB');

      // Advance past the original shutdown deadline — pump must still be on.
      await jest.advanceTimersByTimeAsync(5000);
      expect(setPumpState).toHaveBeenCalledTimes(1);
      expect(orch.isPumpOn()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('PumpOrchestrator — concurrency', () => {
  it('serialises concurrent requestPumpStart calls onto a single startup', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 2 });
      const p1 = orch.requestPumpStart('zoneA');
      const p2 = orch.requestPumpStart('zoneB');

      await jest.advanceTimersByTimeAsync(2000);
      await Promise.all([p1, p2]);

      expect(setPumpState).toHaveBeenCalledTimes(1);
      expect(setPumpState).toHaveBeenCalledWith(true);
      expect(orch.activeZoneCount()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('PumpOrchestrator — forceStop', () => {
  it('clears active zones and powers the pump off immediately', async () => {
    jest.useFakeTimers();
    try {
      const { orch, setPumpState } = makeOrchestrator({ preRunSec: 0, postRunSec: 5 });
      await orch.requestPumpStart('zoneA');
      await orch.forceStop();
      expect(setPumpState).toHaveBeenLastCalledWith(false);
      expect(orch.isPumpOn()).toBe(false);
      expect(orch.activeZoneCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing when the pump is already off', async () => {
    const { orch, setPumpState } = makeOrchestrator();
    await orch.forceStop();
    expect(setPumpState).not.toHaveBeenCalled();
  });
});

describe('PumpOrchestrator — error handling', () => {
  it('propagates a startup error to the caller', async () => {
    const setPumpState = jest.fn().mockRejectedValueOnce(new Error('Hue offline'));
    const orch = new PumpOrchestrator({
      config: { ...baseConfig, preRunSec: 0 },
      setPumpState,
    });
    await expect(orch.requestPumpStart('zoneA')).rejects.toThrow('Hue offline');
  });
});
