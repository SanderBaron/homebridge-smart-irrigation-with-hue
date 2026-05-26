import { TtlCache } from '../src/ttlCache';

describe('TtlCache', () => {
  it('computes the value on first access', async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(42);
    await expect(cache.getOrCompute(compute)).resolves.toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('serves cached values within the TTL', async () => {
    let now = 1000;
    const cache = new TtlCache<number>(500, () => now);
    const compute = jest.fn().mockResolvedValue(1);
    await cache.getOrCompute(compute);
    now += 400;
    await cache.getOrCompute(compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes once the TTL has elapsed', async () => {
    let now = 1000;
    const cache = new TtlCache<number>(500, () => now);
    const compute = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.getOrCompute(compute);
    now += 600;
    const result = await cache.getOrCompute(compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(result).toBe(2);
  });

  it('invalidate forces a recompute on next access', async () => {
    const cache = new TtlCache<number>(10_000);
    const compute = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.getOrCompute(compute);
    cache.invalidate();
    const second = await cache.getOrCompute(compute);
    expect(second).toBe(2);
  });

  it('peek returns the cached value without recomputing, undefined when expired', async () => {
    let now = 1000;
    const cache = new TtlCache<number>(500, () => now);
    expect(cache.peek()).toBeUndefined();
    await cache.getOrCompute(() => Promise.resolve(7));
    expect(cache.peek()).toBe(7);
    now += 600;
    expect(cache.peek()).toBeUndefined();
  });
});
