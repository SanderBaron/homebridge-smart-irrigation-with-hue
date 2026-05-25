import {
  discoverBridges,
  type BonjourBrowserLike,
  type BonjourLike,
  type MdnsService,
} from '../../src/hue/discovery';

interface MockBrowser extends BonjourBrowserLike {
  emitUp(service: MdnsService): void;
  stopCalls: number;
}

function createMockBonjour(): {
  bonjour: BonjourLike;
  browser: MockBrowser;
  destroyCalls: () => number;
} {
  let upListener: ((service: MdnsService) => void) | undefined;
  let stopCalls = 0;
  let destroyCalls = 0;

  const browser: MockBrowser = {
    on(_event, listener) {
      upListener = listener;
      return this;
    },
    stop() {
      stopCalls += 1;
    },
    emitUp(service) {
      upListener?.(service);
    },
    get stopCalls() {
      return stopCalls;
    },
  };

  const bonjour: BonjourLike = {
    find() {
      return browser;
    },
    destroy() {
      destroyCalls += 1;
    },
  };

  return { bonjour, browser, destroyCalls: () => destroyCalls };
}

function makeService(overrides: Partial<MdnsService> = {}): MdnsService {
  return {
    addresses: ['192.0.2.1'],
    name: 'Philips Hue',
    host: 'Philips-hue.local',
    fqdn: 'Philips-hue._hue._tcp.local',
    txt: { bridgeid: 'abc123def456' },
    ...overrides,
  };
}

describe('discoverBridges', () => {
  it('parses an mDNS service into a BridgeCandidate', async () => {
    const { bonjour, browser, destroyCalls } = createMockBonjour();
    const promise = discoverBridges({ timeoutMs: 30, cloudFallback: false, bonjour });
    browser.emitUp(makeService());

    const result = await promise;
    expect(result).toEqual([
      {
        id: 'ABC123DEF456',
        ip: '192.0.2.1',
        name: 'Philips Hue',
        source: 'mdns',
      },
    ]);
    expect(browser.stopCalls).toBe(1);
    expect(destroyCalls()).toBe(1);
  });

  it('deduplicates the same bridge announced twice', async () => {
    const { bonjour, browser } = createMockBonjour();
    const promise = discoverBridges({ timeoutMs: 30, cloudFallback: false, bonjour });
    browser.emitUp(makeService());
    browser.emitUp(makeService());

    const result = await promise;
    expect(result).toHaveLength(1);
  });

  it('returns an empty list when mDNS finds nothing and cloud fallback is disabled', async () => {
    const { bonjour } = createMockBonjour();
    const result = await discoverBridges({ timeoutMs: 20, cloudFallback: false, bonjour });
    expect(result).toEqual([]);
  });

  it('falls back to cloud discovery when mDNS is empty', async () => {
    const { bonjour } = createMockBonjour();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 'aabbccdd', internalipaddress: '192.0.2.1' }]), {
          status: 200,
        }),
      ) as unknown as typeof fetch;

    const result = await discoverBridges({
      timeoutMs: 20,
      cloudFallback: true,
      bonjour,
      fetchImpl,
    });
    expect(result).toEqual([{ id: 'AABBCCDD', ip: '192.0.2.1', source: 'cloud' }]);
  });

  it('returns empty when cloud discovery fails', async () => {
    const { bonjour } = createMockBonjour();
    const fetchImpl = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    const result = await discoverBridges({
      timeoutMs: 20,
      cloudFallback: true,
      bonjour,
      fetchImpl,
    });
    expect(result).toEqual([]);
  });

  it('ignores services without an IPv4 address', async () => {
    const { bonjour, browser } = createMockBonjour();
    const promise = discoverBridges({ timeoutMs: 20, cloudFallback: false, bonjour });
    browser.emitUp(makeService({ addresses: ['fe80::1'] }));
    const result = await promise;
    expect(result).toEqual([]);
  });

  it('always destroys the Bonjour instance even when listening throws', async () => {
    const { bonjour, destroyCalls } = createMockBonjour();
    await discoverBridges({ timeoutMs: 10, cloudFallback: false, bonjour });
    expect(destroyCalls()).toBe(1);
  });
});
