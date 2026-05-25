import { formatWindSpeed, fromMs, toMs } from '../src/unitConverter';

describe('fromMs', () => {
  it.each([
    [0, 'm/s', 0],
    [5, 'm/s', 5],
    [5, 'km/h', 18],
    [10, 'km/h', 36],
    [5, 'mph', 11.2],
    [5, 'kts', 9.7],
  ] as const)('converts %p m/s to %p in %p', (input, unit, expected) => {
    expect(fromMs(input, unit)).toBeCloseTo(expected, 1);
  });

  it('clamps negative input to zero', () => {
    expect(fromMs(-3, 'km/h')).toBe(0);
  });

  it('returns integer Beaufort values matching the spec ranges', () => {
    // Beaufort scale anchor points (Wikipedia midpoints):
    // Bft 0 ≈ 0 m/s, Bft 3 ≈ 4 m/s, Bft 5 ≈ 9.35 m/s, Bft 8 ≈ ~18.9 m/s
    expect(fromMs(0, 'Bft')).toBe(0);
    expect(fromMs(4, 'Bft')).toBe(3);
    expect(fromMs(9.35, 'Bft')).toBe(5);
    expect(Number.isInteger(fromMs(7.3, 'Bft'))).toBe(true);
  });
});

describe('toMs', () => {
  it.each([
    [18, 'km/h', 5],
    [11.18, 'mph', 5],
    [9.72, 'kts', 5],
    [3.6, 'm/s', 3.6],
  ] as const)('converts %p %p to %p m/s', (value, unit, expected) => {
    expect(toMs(value, unit)).toBeCloseTo(expected, 1);
  });

  it('converts Beaufort to m/s using v = 0.836·B^(3/2)', () => {
    expect(toMs(5, 'Bft')).toBeCloseTo(9.35, 1);
    expect(toMs(0, 'Bft')).toBe(0);
  });

  it('clamps negative input to zero', () => {
    expect(toMs(-5, 'km/h')).toBe(0);
  });
});

describe('round-trip', () => {
  it.each(['m/s', 'km/h', 'mph', 'kts'] as const)('round-trips through %p', (unit) => {
    const original = 7.2;
    const there = fromMs(original, unit);
    const back = toMs(there, unit);
    expect(back).toBeCloseTo(original, 1);
  });

  it('round-trips Beaufort whole numbers exactly', () => {
    for (let b = 0; b <= 12; b++) {
      const ms = toMs(b, 'Bft');
      expect(fromMs(ms, 'Bft')).toBe(b);
    }
  });
});

describe('formatWindSpeed', () => {
  it('renders Beaufort with the Bft prefix', () => {
    expect(formatWindSpeed(9.35, 'Bft')).toBe('Bft 5');
  });

  it('renders metric units with a trailing unit string', () => {
    expect(formatWindSpeed(5, 'm/s')).toBe('5 m/s');
    expect(formatWindSpeed(5, 'km/h')).toBe('18 km/h');
  });
});
