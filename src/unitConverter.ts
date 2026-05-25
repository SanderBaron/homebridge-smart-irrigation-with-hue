import type { WindUnit } from './types';

/**
 * Wind speed unit conversions used at the UI edge.
 *
 * Internally every wind speed is stored and reasoned about in **m/s**. The
 * functions here convert to and from the user's preferred display unit
 * (m/s, km/h, mph, knots, or Beaufort) and should be the only place in the
 * codebase that touches non-metric numbers.
 *
 * Conversion factors are taken verbatim from the project spec:
 * - m/s → km/h: × 3.6
 * - m/s → mph: × 2.237
 * - m/s → kts: × 1.944
 * - m/s → Bft: B = (v/0.836)^(2/3), rounded to integer
 *
 * Beaufort is a discrete scale: `fromMs(v, 'Bft')` returns an integer, and
 * `toMs(B, 'Bft')` returns the m/s value that corresponds exactly to that
 * Beaufort number (mid-band, since each Bft step covers a range of m/s).
 */

const MS_PER_KMH = 1 / 3.6;
const MS_PER_MPH = 1 / 2.237;
const MS_PER_KTS = 1 / 1.944;
const BFT_COEFF = 0.836;

/**
 * Convert an internal m/s value to the given display unit. Always returns a
 * finite, non-negative number. Beaufort results are integers; the other units
 * are rounded to 1 decimal place to keep UI strings tidy.
 */
export function fromMs(valueMs: number, unit: WindUnit): number {
  const v = Math.max(0, valueMs);
  switch (unit) {
    case 'm/s':
      return round(v, 1);
    case 'km/h':
      return round(v * 3.6, 1);
    case 'mph':
      return round(v * 2.237, 1);
    case 'kts':
      return round(v * 1.944, 1);
    case 'Bft':
      return Math.round((v / BFT_COEFF) ** (2 / 3));
  }
}

/**
 * Convert a value entered in the user's unit back to m/s for internal storage.
 * Beaufort input is interpreted as `v = 0.836 · B^(3/2)` — the value at which
 * `fromMs(v, 'Bft')` would round-trip to the same integer.
 */
export function toMs(value: number, unit: WindUnit): number {
  const v = Math.max(0, value);
  switch (unit) {
    case 'm/s':
      return round(v, 3);
    case 'km/h':
      return round(v * MS_PER_KMH, 3);
    case 'mph':
      return round(v * MS_PER_MPH, 3);
    case 'kts':
      return round(v * MS_PER_KTS, 3);
    case 'Bft':
      return round(BFT_COEFF * v ** 1.5, 3);
  }
}

/**
 * Format a wind speed for display: numeric value followed by unit, except
 * Beaufort which is printed as "Bft N". Useful for log lines like
 * `"6.5 m/s (Bft 4)"`.
 */
export function formatWindSpeed(valueMs: number, unit: WindUnit): string {
  const converted = fromMs(valueMs, unit);
  return unit === 'Bft' ? `Bft ${converted}` : `${converted} ${unit}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
