import { defaultState, StateStore, STATE_FILE_NAME, type StateFs } from '../src/state';
import path from 'node:path';

class MemFs implements StateFs {
  private readonly files = new Map<string, string>();
  public failNextWrite = false;

  public readFile = jest.fn((p: string): Promise<string> => {
    const data = this.files.get(p);
    if (data === undefined) {
      const err: NodeJS.ErrnoException = new Error('ENOENT');
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    return Promise.resolve(data);
  });

  public writeFile = jest.fn((p: string, data: string): Promise<void> => {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('disk full'));
    }
    this.files.set(p, data);
    return Promise.resolve();
  });

  public rename = jest.fn((from: string, to: string): Promise<void> => {
    const data = this.files.get(from);
    if (data === undefined) {
      return Promise.reject(new Error(`no such file ${from}`));
    }
    this.files.set(to, data);
    this.files.delete(from);
    return Promise.resolve();
  });

  public unlink = jest.fn((p: string): Promise<void> => {
    this.files.delete(p);
    return Promise.resolve();
  });

  public peek(p: string): string | undefined {
    return this.files.get(p);
  }

  public seed(p: string, data: string): void {
    this.files.set(p, data);
  }
}

const STORAGE_DIR = '/tmp/test-irrigation';
const STATE_PATH = path.join(STORAGE_DIR, STATE_FILE_NAME);

describe('StateStore — load', () => {
  it('returns default state when the file does not exist', async () => {
    const fsImpl = new MemFs();
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const state = await store.load();
    expect(state).toEqual(defaultState());
  });

  it('returns default state on malformed JSON', async () => {
    const fsImpl = new MemFs();
    fsImpl.seed(STATE_PATH, '{not valid json');
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const state = await store.load();
    expect(state.scheduleActive).toBe(false);
  });

  it('returns default state when version differs', async () => {
    const fsImpl = new MemFs();
    fsImpl.seed(STATE_PATH, JSON.stringify({ version: 999, scheduleActive: true }));
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const state = await store.load();
    expect(state.scheduleActive).toBe(false);
  });

  it('parses a well-formed state file including weather snapshots', async () => {
    const fsImpl = new MemFs();
    fsImpl.seed(
      STATE_PATH,
      JSON.stringify({
        version: 1,
        scheduleActive: true,
        schedulerFiredToday: { e1: '2026-05-26' },
        weatherSnapshots: [
          {
            source: 'open-meteo',
            observedAt: '2026-05-26T08:00:00.000Z',
            windSpeedMs: 4.2,
            windDirectionDeg: 235,
            rainLast24hMm: 0,
            rainNext12hMm: 1.5,
          },
        ],
        savedAt: 1_700_000_000_000,
      }),
    );
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const state = await store.load();
    expect(state.scheduleActive).toBe(true);
    expect(state.schedulerFiredToday['e1']).toBe('2026-05-26');
    expect(state.weatherSnapshots[0]?.observedAt).toBeInstanceOf(Date);
    expect(state.weatherSnapshots[0]?.windSpeedMs).toBe(4.2);
  });

  it('drops snapshots with unknown source or invalid date', async () => {
    const fsImpl = new MemFs();
    fsImpl.seed(
      STATE_PATH,
      JSON.stringify({
        version: 1,
        weatherSnapshots: [
          { source: 'unknown', observedAt: '2026-05-26T08:00:00.000Z' },
          { source: 'open-meteo', observedAt: 'not-a-date' },
          { source: 'open-meteo', observedAt: '2026-05-26T08:00:00.000Z', windSpeedMs: 1 },
        ],
      }),
    );
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const state = await store.load();
    expect(state.weatherSnapshots).toHaveLength(1);
    expect(state.weatherSnapshots[0]?.source).toBe('open-meteo');
  });
});

describe('StateStore — save', () => {
  it('writes to a .tmp file then renames atomically', async () => {
    const fsImpl = new MemFs();
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    await store.save({
      ...defaultState(),
      scheduleActive: true,
    });
    expect(fsImpl.writeFile).toHaveBeenCalledWith(`${STATE_PATH}.tmp`, expect.any(String));
    expect(fsImpl.rename).toHaveBeenCalledWith(`${STATE_PATH}.tmp`, STATE_PATH);
    const written = fsImpl.peek(STATE_PATH);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written ?? '{}') as { scheduleActive: boolean };
    expect(parsed.scheduleActive).toBe(true);
  });

  it('round-trips Date observedAt as ISO string', async () => {
    const fsImpl = new MemFs();
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    const isoDate = new Date('2026-05-26T08:00:00.000Z');
    await store.save({
      ...defaultState(),
      weatherSnapshots: [
        {
          source: 'open-meteo',
          observedAt: isoDate,
          windSpeedMs: 3,
        },
      ],
    });
    const loaded = await store.load();
    expect(loaded.weatherSnapshots[0]?.observedAt.toISOString()).toBe(isoDate.toISOString());
  });

  it('does not throw when the underlying write fails', async () => {
    const fsImpl = new MemFs();
    fsImpl.failNextWrite = true;
    const store = new StateStore({ storageDir: STORAGE_DIR, fsImpl });
    await expect(store.save(defaultState())).resolves.toBeUndefined();
  });
});
