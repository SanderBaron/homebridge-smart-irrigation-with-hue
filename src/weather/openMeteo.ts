import { WeatherError, type FetchOptions, type WeatherSnapshot } from './types';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

interface OpenMeteoResponse {
  current?: {
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    time?: string;
  };
  hourly?: {
    time?: string[];
    precipitation?: number[];
  };
}

/**
 * Fetch a {@link WeatherSnapshot} from Open-Meteo.
 *
 * Open-Meteo is the primary weather source: keyless, ECMWF-backed, and able
 * to return all four metrics in a single request. Wind is requested directly
 * in m/s so no conversion happens at this layer.
 *
 * @throws {@link WeatherError} on timeout, network, http, or protocol failure.
 */
export async function fetchOpenMeteo(options: FetchOptions): Promise<WeatherSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set('latitude', options.latitude.toString());
  url.searchParams.set('longitude', options.longitude.toString());
  url.searchParams.set('current', 'wind_speed_10m,wind_direction_10m');
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('past_hours', '24');
  url.searchParams.set('forecast_hours', '12');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone', 'auto');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WeatherError('Open-Meteo request timed out', 'open-meteo', 'timeout', {
        cause: err,
      });
    }
    throw new WeatherError('Open-Meteo network error', 'open-meteo', 'network', { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new WeatherError(`Open-Meteo returned HTTP ${res.status}`, 'open-meteo', 'http', {
      httpStatus: res.status,
    });
  }

  let body: OpenMeteoResponse;
  try {
    body = (await res.json()) as OpenMeteoResponse;
  } catch (err) {
    throw new WeatherError('Open-Meteo response was not JSON', 'open-meteo', 'protocol', {
      cause: err,
    });
  }

  return parseOpenMeteo(body);
}

export function parseOpenMeteo(body: OpenMeteoResponse): WeatherSnapshot {
  const snapshot: WeatherSnapshot = {
    observedAt: new Date(),
    source: 'open-meteo',
  };

  const current = body.current;
  if (current !== undefined) {
    if (typeof current.wind_speed_10m === 'number') {
      snapshot.windSpeedMs = current.wind_speed_10m;
    }
    if (typeof current.wind_direction_10m === 'number') {
      snapshot.windDirectionDeg = normaliseBearing(current.wind_direction_10m);
    }
    if (typeof current.time === 'string') {
      const parsed = new Date(current.time);
      if (!Number.isNaN(parsed.getTime())) {
        snapshot.observedAt = parsed;
      }
    }
  }

  const hourlyPrecip = body.hourly?.precipitation;
  if (Array.isArray(hourlyPrecip)) {
    // Open-Meteo returns 24 past entries followed by the requested forecast
    // entries. We requested past_hours=24 + forecast_hours=12, so the layout
    // is precipitation[0..23] = previous 24 hours, [24..35] = next 12 hours.
    const past24 = sumSlice(hourlyPrecip, 0, 24);
    const next12 = sumSlice(hourlyPrecip, 24, 36);
    if (past24 !== undefined) {
      snapshot.rainLast24hMm = past24;
    }
    if (next12 !== undefined) {
      snapshot.rainNext12hMm = next12;
    }
  }

  return snapshot;
}

function sumSlice(arr: number[], start: number, end: number): number | undefined {
  const slice = arr.slice(start, end);
  if (slice.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const v of slice) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      total += v;
    }
  }
  return roundTo(total, 2);
}

function normaliseBearing(deg: number): number {
  const mod = ((deg % 360) + 360) % 360;
  return mod;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
