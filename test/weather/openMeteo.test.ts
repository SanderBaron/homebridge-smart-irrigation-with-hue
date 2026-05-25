import { fetchOpenMeteo, parseOpenMeteo } from '../../src/weather/openMeteo';
import { WeatherError } from '../../src/weather/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SAMPLE_BODY = {
  current: {
    time: '2026-05-26T08:00',
    wind_speed_10m: 4.2,
    wind_direction_10m: 235,
  },
  hourly: {
    // 24 past hours then 12 forecast hours = 36 entries
    precipitation: [
      ...Array.from({ length: 24 }, (_, i) => (i === 5 ? 1.5 : 0)),
      ...Array.from({ length: 12 }, (_, i) => (i === 0 ? 0.5 : 0)),
    ],
  },
};

describe('parseOpenMeteo', () => {
  it('extracts wind and rain metrics', () => {
    const snap = parseOpenMeteo(SAMPLE_BODY);
    expect(snap.source).toBe('open-meteo');
    expect(snap.windSpeedMs).toBe(4.2);
    expect(snap.windDirectionDeg).toBe(235);
    expect(snap.rainLast24hMm).toBe(1.5);
    expect(snap.rainNext12hMm).toBe(0.5);
    expect(snap.observedAt.getUTCFullYear()).toBe(2026);
  });

  it('normalises bearings outside 0..359', () => {
    const snap = parseOpenMeteo({
      current: { wind_direction_10m: 370 },
    });
    expect(snap.windDirectionDeg).toBe(10);
  });

  it('omits fields when the source returns no current block', () => {
    const snap = parseOpenMeteo({});
    expect(snap.windSpeedMs).toBeUndefined();
    expect(snap.rainLast24hMm).toBeUndefined();
  });
});

describe('fetchOpenMeteo', () => {
  it('builds the correct request URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SAMPLE_BODY));
    await fetchOpenMeteo({
      latitude: 52.37,
      longitude: 4.89,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const firstCall = fetchImpl.mock.calls[0] as [string, RequestInit?] | undefined;
    const calledUrl = firstCall?.[0] ?? '';
    expect(calledUrl).toContain('latitude=52.37');
    expect(calledUrl).toContain('longitude=4.89');
    expect(calledUrl).toContain('wind_speed_unit=ms');
    expect(calledUrl).toContain('past_hours=24');
    expect(calledUrl).toContain('forecast_hours=12');
  });

  it('throws a WeatherError on non-2xx', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(
      fetchOpenMeteo({
        latitude: 52,
        longitude: 5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'WeatherError',
      source: 'open-meteo',
      kind: 'http',
      httpStatus: 503,
    });
  });

  it('throws timeout on abort', async () => {
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    await expect(
      fetchOpenMeteo({
        latitude: 52,
        longitude: 5,
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: 'timeout', source: 'open-meteo' });
  });

  it('returns a WeatherError instance on protocol failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('garbage', { status: 200 }));
    await expect(
      fetchOpenMeteo({
        latitude: 52,
        longitude: 5,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(WeatherError);
  });
});
