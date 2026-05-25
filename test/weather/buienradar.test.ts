import { fetchBuienradar, haversineKm, parseBuienradar } from '../../src/weather/buienradar';
import { WeatherError } from '../../src/weather/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SAMPLE_BODY = {
  actual: {
    stationmeasurements: [
      {
        stationname: 'Meetstation Arnhem',
        lat: 52.07,
        lon: 5.88,
        windspeed: 0.3,
        winddirectiondegrees: 181,
        rainFallLast24Hour: 0.0,
        timestamp: '2026-05-26T08:00:00',
      },
      {
        stationname: 'Meetstation Schiphol',
        lat: 52.3,
        lon: 4.78,
        windspeed: 5.5,
        winddirectiondegrees: 270,
        rainFallLast24Hour: 1.2,
        timestamp: '2026-05-26T08:00:00',
      },
      {
        stationname: 'Buoy without coords',
        windspeed: 9.9,
      },
    ],
  },
};

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    expect(haversineKm(52, 4, 52, 4)).toBe(0);
  });

  it('approximates the Amsterdam–Berlin great-circle distance (~575 km)', () => {
    const d = haversineKm(52.37, 4.89, 52.52, 13.4);
    expect(d).toBeGreaterThan(560);
    expect(d).toBeLessThan(590);
  });
});

describe('parseBuienradar', () => {
  it('picks the nearest station to the requested location', () => {
    // Schiphol (52.30, 4.78) is closer to Amsterdam than Arnhem (52.07, 5.88)
    const snap = parseBuienradar(SAMPLE_BODY, 52.37, 4.89);
    expect(snap.source).toBe('buienradar');
    expect(snap.windSpeedMs).toBe(5.5);
    expect(snap.windDirectionDeg).toBe(270);
    expect(snap.rainLast24hMm).toBe(1.2);
  });

  it('skips stations without coordinates', () => {
    // The coordinate-less station has the highest windspeed but must be ignored
    const snap = parseBuienradar(SAMPLE_BODY, 52.0, 6.0);
    expect(snap.windSpeedMs).toBe(0.3); // Arnhem, nearest with coords
  });

  it('throws a protocol error when no station has usable coordinates', () => {
    expect(() =>
      parseBuienradar({ actual: { stationmeasurements: [{ stationname: 'orphan' }] } }, 52, 4),
    ).toThrow(WeatherError);
  });
});

describe('fetchBuienradar', () => {
  it('returns a snapshot for a valid response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(SAMPLE_BODY));
    const snap = await fetchBuienradar({
      latitude: 52.37,
      longitude: 4.89,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(snap.source).toBe('buienradar');
  });

  it('throws WeatherError on HTTP failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(
      fetchBuienradar({
        latitude: 52,
        longitude: 4,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ source: 'buienradar', kind: 'http', httpStatus: 500 });
  });

  it('throws a timeout WeatherError on abort', async () => {
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
      fetchBuienradar({
        latitude: 52,
        longitude: 4,
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ source: 'buienradar', kind: 'timeout' });
  });
});
