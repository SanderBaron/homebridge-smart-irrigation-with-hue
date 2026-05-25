import { WeatherError, type FetchOptions, type WeatherSnapshot } from './types';

const CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
/** Number of 3-hour forecast slots to sum for "next 12 hours" (4 × 3h = 12h). */
const FORECAST_SLOTS_12H = 4;

export interface OpenWeatherMapFetchOptions extends FetchOptions {
  /** API key from openweathermap.org. The source throws a config WeatherError when missing. */
  apiKey: string;
}

interface OwmCurrentResponse {
  wind?: {
    speed?: number;
    deg?: number;
  };
  dt?: number;
}

interface OwmForecastEntry {
  rain?: {
    '3h'?: number;
  };
}

interface OwmForecastResponse {
  list?: OwmForecastEntry[];
}

/**
 * Fetch a {@link WeatherSnapshot} from OpenWeatherMap.
 *
 * Uses two free-tier endpoints in parallel: `weather` (current conditions) and
 * `forecast` (5-day / 3-hour). Wind comes from the current call; the next-12h
 * rainfall is summed from the first four 3-hour forecast slots. The free tier
 * does not expose historical data, so `rainLast24hMm` is intentionally absent.
 *
 * If both upstream calls fail, throws a single {@link WeatherError}; if only
 * one fails, returns whatever metrics the surviving call provided.
 *
 * @throws {@link WeatherError} with kind `config` when `apiKey` is missing/empty.
 */
export async function fetchOpenWeatherMap(
  options: OpenWeatherMapFetchOptions,
): Promise<WeatherSnapshot> {
  if (options.apiKey === undefined || options.apiKey.trim() === '') {
    throw new WeatherError(
      'OpenWeatherMap API key is required but missing',
      'openweathermap',
      'config',
    );
  }

  const [currentResult, forecastResult] = await Promise.allSettled([
    fetchCurrent(options),
    fetchForecast(options),
  ]);

  if (currentResult.status === 'rejected' && forecastResult.status === 'rejected') {
    // Propagate the first failure — both rejections are typically the same
    // class of problem (network down, bad key, etc.).
    throw currentResult.reason instanceof WeatherError
      ? currentResult.reason
      : new WeatherError('OpenWeatherMap requests failed', 'openweathermap', 'network', {
          cause: currentResult.reason,
        });
  }

  const snapshot: WeatherSnapshot = {
    observedAt: new Date(),
    source: 'openweathermap',
  };

  if (currentResult.status === 'fulfilled') {
    const current = currentResult.value;
    if (typeof current.wind?.speed === 'number') {
      snapshot.windSpeedMs = current.wind.speed;
    }
    if (typeof current.wind?.deg === 'number') {
      snapshot.windDirectionDeg = normaliseBearing(current.wind.deg);
    }
    if (typeof current.dt === 'number') {
      snapshot.observedAt = new Date(current.dt * 1000);
    }
  }

  if (forecastResult.status === 'fulfilled') {
    const list = forecastResult.value.list ?? [];
    const slots = list.slice(0, FORECAST_SLOTS_12H);
    if (slots.length > 0) {
      let total = 0;
      for (const entry of slots) {
        const rain = entry.rain?.['3h'];
        if (typeof rain === 'number') {
          total += rain;
        }
      }
      snapshot.rainNext12hMm = roundTo(total, 2);
    }
  }

  return snapshot;
}

async function fetchCurrent(options: OpenWeatherMapFetchOptions): Promise<OwmCurrentResponse> {
  return owmRequest<OwmCurrentResponse>(CURRENT_URL, options);
}

async function fetchForecast(options: OpenWeatherMapFetchOptions): Promise<OwmForecastResponse> {
  return owmRequest<OwmForecastResponse>(FORECAST_URL, options);
}

async function owmRequest<T>(baseUrl: string, options: OpenWeatherMapFetchOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  const url = new URL(baseUrl);
  url.searchParams.set('lat', options.latitude.toString());
  url.searchParams.set('lon', options.longitude.toString());
  url.searchParams.set('appid', options.apiKey);
  url.searchParams.set('units', 'metric');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WeatherError(
        `OpenWeatherMap request to ${baseUrl} timed out`,
        'openweathermap',
        'timeout',
        { cause: err },
      );
    }
    throw new WeatherError('OpenWeatherMap network error', 'openweathermap', 'network', {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new WeatherError(`OpenWeatherMap returned HTTP ${res.status}`, 'openweathermap', 'http', {
      httpStatus: res.status,
    });
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new WeatherError('OpenWeatherMap response was not JSON', 'openweathermap', 'protocol', {
      cause: err,
    });
  }
}

function normaliseBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
