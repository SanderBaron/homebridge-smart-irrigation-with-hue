import { fetchOpenWeatherMap } from '../../src/weather/openWeatherMap';
import { WeatherError } from '../../src/weather/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockFetchByUrl(handlers: Record<string, () => Promise<Response> | Response>): jest.Mock {
  return jest.fn().mockImplementation(async (url: string) => {
    for (const [matcher, handler] of Object.entries(handlers)) {
      if (url.includes(matcher)) {
        return handler();
      }
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

const CURRENT_BODY = {
  wind: { speed: 5.5, deg: 270 },
  dt: 1748246400, // 2025-05-26T08:00:00Z
  rain: { '1h': 0.2 },
};

const FORECAST_BODY = {
  list: [
    { rain: { '3h': 0.3 } },
    { rain: { '3h': 0.5 } },
    {}, // no rain entry
    { rain: { '3h': 0.2 } },
    { rain: { '3h': 99 } }, // should be ignored — only first 4 slots matter
  ],
};

describe('fetchOpenWeatherMap', () => {
  it('rejects with a config WeatherError when the API key is missing', async () => {
    await expect(
      fetchOpenWeatherMap({
        latitude: 52,
        longitude: 5,
        apiKey: '',
        fetchImpl: jest.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      source: 'openweathermap',
      kind: 'config',
    });
  });

  it('combines current and forecast responses into one snapshot', async () => {
    const fetchImpl = mockFetchByUrl({
      '/weather': () => jsonResponse(CURRENT_BODY),
      '/forecast': () => jsonResponse(FORECAST_BODY),
    });
    const snap = await fetchOpenWeatherMap({
      latitude: 52,
      longitude: 5,
      apiKey: 'abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(snap.source).toBe('openweathermap');
    expect(snap.windSpeedMs).toBe(5.5);
    expect(snap.windDirectionDeg).toBe(270);
    // 0.3 + 0.5 + 0 + 0.2 = 1.0 mm in the next 12h
    expect(snap.rainNext12hMm).toBe(1);
    expect(snap.rainLast24hMm).toBeUndefined();
  });

  it('returns a partial snapshot when only the forecast call succeeds', async () => {
    const fetchImpl = mockFetchByUrl({
      '/weather': () => new Response('boom', { status: 502 }),
      '/forecast': () => jsonResponse(FORECAST_BODY),
    });
    const snap = await fetchOpenWeatherMap({
      latitude: 52,
      longitude: 5,
      apiKey: 'abc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(snap.windSpeedMs).toBeUndefined();
    expect(snap.rainNext12hMm).toBe(1);
  });

  it('throws a WeatherError when both calls fail', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      fetchOpenWeatherMap({
        latitude: 52,
        longitude: 5,
        apiKey: 'abc',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(WeatherError);
  });

  it('includes the API key and units in the query string', async () => {
    const fetchImpl = mockFetchByUrl({
      '/weather': () => jsonResponse(CURRENT_BODY),
      '/forecast': () => jsonResponse(FORECAST_BODY),
    });
    await fetchOpenWeatherMap({
      latitude: 52,
      longitude: 5,
      apiKey: 'my-secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const calls = (fetchImpl.mock.calls as Array<[string, RequestInit?]>).map((c) => c[0] ?? '');
    expect(calls.every((u) => u.includes('appid=my-secret-key'))).toBe(true);
    expect(calls.every((u) => u.includes('units=metric'))).toBe(true);
  });
});
