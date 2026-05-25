import { WeatherError, type FetchOptions, type WeatherSnapshot } from './types';

const BUIENRADAR_URL = 'https://data.buienradar.nl/2.0/feed/json';

interface BuienradarStation {
  stationname?: string;
  lat?: number;
  lon?: number;
  windspeed?: number;
  winddirectiondegrees?: number;
  rainFallLast24Hour?: number;
  timestamp?: string;
}

interface BuienradarResponse {
  actual?: {
    stationmeasurements?: BuienradarStation[];
  };
}

/**
 * Fetch a {@link WeatherSnapshot} from the Buienradar live feed.
 *
 * The feed publishes ~39 KNMI weather stations across the Netherlands; this
 * function picks the geographically nearest one (great-circle distance) and
 * extracts its current wind and past-24h precipitation. The feed has no
 * forecast component, so `rainNext12hMm` is intentionally absent — the
 * consensus engine treats that as an abstention rather than a zero vote.
 *
 * @throws {@link WeatherError} on timeout, network, http, or protocol failure.
 */
export async function fetchBuienradar(options: FetchOptions): Promise<WeatherSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(BUIENRADAR_URL, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WeatherError('Buienradar request timed out', 'buienradar', 'timeout', {
        cause: err,
      });
    }
    throw new WeatherError('Buienradar network error', 'buienradar', 'network', { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new WeatherError(`Buienradar returned HTTP ${res.status}`, 'buienradar', 'http', {
      httpStatus: res.status,
    });
  }

  let body: BuienradarResponse;
  try {
    body = (await res.json()) as BuienradarResponse;
  } catch (err) {
    throw new WeatherError('Buienradar response was not JSON', 'buienradar', 'protocol', {
      cause: err,
    });
  }

  return parseBuienradar(body, options.latitude, options.longitude);
}

export function parseBuienradar(
  body: BuienradarResponse,
  latitude: number,
  longitude: number,
): WeatherSnapshot {
  const stations = body.actual?.stationmeasurements ?? [];
  const nearest = findNearestStation(stations, latitude, longitude);
  if (nearest === undefined) {
    throw new WeatherError(
      'Buienradar feed contained no station with usable coordinates',
      'buienradar',
      'protocol',
    );
  }

  const snapshot: WeatherSnapshot = {
    observedAt: parseStationTimestamp(nearest.timestamp) ?? new Date(),
    source: 'buienradar',
  };

  if (typeof nearest.windspeed === 'number') {
    snapshot.windSpeedMs = nearest.windspeed;
  }
  if (typeof nearest.winddirectiondegrees === 'number') {
    snapshot.windDirectionDeg = normaliseBearing(nearest.winddirectiondegrees);
  }
  if (typeof nearest.rainFallLast24Hour === 'number') {
    snapshot.rainLast24hMm = nearest.rainFallLast24Hour;
  }

  return snapshot;
}

function findNearestStation(
  stations: BuienradarStation[],
  latitude: number,
  longitude: number,
): BuienradarStation | undefined {
  let best: BuienradarStation | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const station of stations) {
    if (typeof station.lat !== 'number' || typeof station.lon !== 'number') {
      continue;
    }
    const d = haversineKm(latitude, longitude, station.lat, station.lon);
    if (d < bestDistance) {
      bestDistance = d;
      best = station;
    }
  }
  return best;
}

function parseStationTimestamp(value: string | undefined): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Great-circle distance in kilometres between two WGS84 points. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinDLon * sinDLon;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normaliseBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
