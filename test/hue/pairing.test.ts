import { defaultDeviceType, pairWithBridge } from '../../src/hue/pairing';
import { HueError } from '../../src/hue/types';

function mockFetchOk(body: unknown): typeof fetch {
  return jest
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;
}

function mockFetchAbortable(): typeof fetch {
  return jest.fn().mockImplementation(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      }),
  ) as unknown as typeof fetch;
}

describe('defaultDeviceType', () => {
  it('uses the smartirrigation prefix and joins with #', () => {
    const result = defaultDeviceType('mymac');
    expect(result).toBe('smartirrigation#mymac');
  });

  it('truncates long hostnames to keep total length within 40 chars', () => {
    const long = 'this-is-a-very-long-hostname-indeed-much-longer-than-allowed';
    const result = defaultDeviceType(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.startsWith('smartirrigation#')).toBe(true);
  });

  it('strips the DNS suffix from the hostname', () => {
    const result = defaultDeviceType('example.local');
    expect(result).toBe('smartirrigation#example');
  });
});

describe('pairWithBridge', () => {
  it('returns the username on success', async () => {
    const fetchImpl = mockFetchOk([{ success: { username: 'abc-123-secret' } }]);
    const result = await pairWithBridge({
      ip: '192.0.2.1',
      fetchImpl,
      deviceType: 'smartirrigation#test',
    });
    expect(result).toBe('abc-123-secret');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://192.0.2.1/api',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ devicetype: 'smartirrigation#test' }),
      }),
    );
  });

  it('throws link-not-pressed when the bridge returns error 101', async () => {
    const fetchImpl = mockFetchOk([
      { error: { type: 101, address: '', description: 'link button not pressed' } },
    ]);
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toMatchObject({
      name: 'HueError',
      kind: 'link-not-pressed',
    });
  });

  it('wraps unknown Hue error codes as protocol errors', async () => {
    const fetchImpl = mockFetchOk([{ error: { type: 999, address: '', description: 'unknown' } }]);
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toMatchObject({
      kind: 'protocol',
    });
  });

  it('throws an http error on non-2xx responses', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toMatchObject({
      kind: 'http',
      httpStatus: 502,
    });
  });

  it('throws a timeout error when the request is aborted', async () => {
    const fetchImpl = mockFetchAbortable();
    await expect(
      pairWithBridge({ ip: '192.0.2.1', fetchImpl, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws a network error when fetch rejects with a non-abort error', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('throws a protocol error on malformed JSON', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toMatchObject({
      kind: 'protocol',
    });
  });

  it('exposes errors as HueError instances', async () => {
    const fetchImpl = mockFetchOk([{ error: { type: 101, address: '', description: 'x' } }]);
    await expect(pairWithBridge({ ip: '192.0.2.1', fetchImpl })).rejects.toBeInstanceOf(HueError);
  });
});
