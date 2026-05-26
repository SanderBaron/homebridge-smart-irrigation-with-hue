import { HueClient } from '../../src/hue/client';
import { HueError } from '../../src/hue/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeFetch(...responses: Array<() => Response | Promise<Response> | never>): jest.Mock {
  const mock = jest.fn();
  for (const fn of responses) {
    mock.mockImplementationOnce(async () => fn());
  }
  return mock;
}

const SAMPLE_LIGHTS = {
  '1': {
    name: 'Garden socket',
    type: 'On/Off plug-in unit',
    modelid: 'LOM001',
    manufacturername: 'Signify Netherlands B.V.',
    state: { on: false, reachable: true },
  },
  '2': {
    name: 'Pump socket',
    type: 'On/Off plug-in unit',
    modelid: 'LOM001',
    manufacturername: 'Signify Netherlands B.V.',
    state: { on: true, reachable: true },
  },
};

describe('HueClient.getConfig', () => {
  it('returns the bridge config payload', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        name: 'Philips Hue',
        bridgeid: 'ABC',
        modelid: 'BSB002',
        apiversion: '1.65.0',
        swversion: '1969091050',
      }),
    );
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const cfg = await client.getConfig();
    expect(cfg.bridgeid).toBe('ABC');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://1.2.3.4/api/config',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('HueClient.getLights', () => {
  it('flattens the map response into an array', async () => {
    const fetchImpl = makeFetch(() => jsonResponse(SAMPLE_LIGHTS));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lights = await client.getLights();
    expect(lights).toHaveLength(2);
    expect(lights[0]).toEqual({
      id: '1',
      name: 'Garden socket',
      type: 'On/Off plug-in unit',
      modelid: 'LOM001',
      manufacturername: 'Signify Netherlands B.V.',
      reachable: true,
      on: false,
    });
    expect(lights[1]?.on).toBe(true);
  });
});

describe('HueClient.setLightOn', () => {
  it('issues a PUT with the correct body and path', async () => {
    const fetchImpl = makeFetch(() => jsonResponse([{ success: { '/lights/1/state/on': true } }]));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.setLightOn('1', true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://1.2.3.4/api/key/lights/1/state',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ on: true }),
      }),
    );
  });

  it('maps Hue error type 1 to an unauthorized HueError', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse([{ error: { type: 1, address: '/lights', description: 'unauthorized user' } }]),
    );
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'bad-key',
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.setLightOn('1', true)).rejects.toMatchObject({
      name: 'HueError',
      kind: 'unauthorized',
    });
  });
});

describe('HueClient retry behaviour', () => {
  it('retries once on a transient network error then succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_LIGHTS));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      retries: 1,
      backoffMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lights = await client.getLights();
    expect(lights).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 4xx response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      retries: 3,
      backoffMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getLights()).rejects.toMatchObject({ kind: 'http', httpStatus: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on a 5xx response', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_LIGHTS));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      retries: 1,
      backoffMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const lights = await client.getLights();
    expect(lights).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a timeout HueError when aborted', async () => {
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
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'key',
      timeoutMs: 20,
      retries: 0,
      backoffMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getConfig()).rejects.toBeInstanceOf(HueError);
    await expect(client.getConfig()).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('HueClient.healthCheck', () => {
  it('returns true on a 2xx config response', async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        name: 'Bridge',
        bridgeid: 'X',
        modelid: 'BSB002',
        apiversion: '1.65',
        swversion: '1',
      }),
    );
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.healthCheck()).resolves.toBe(true);
  });

  it('returns false when the bridge cannot be reached', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const client = new HueClient({
      ip: '1.2.3.4',
      apiKey: 'k',
      retries: 0,
      backoffMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.healthCheck()).resolves.toBe(false);
  });
});
