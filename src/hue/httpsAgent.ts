import type { Dispatcher } from 'undici-types';

/**
 * Hue Bridge HTTPS dispatcher.
 *
 * Recent Hue Bridges (BSB002 v2 firmware, BSB003 Pro) force HTTPS on port 443
 * and serve a self-signed certificate whose CN does not match the bridge's
 * LAN IP. Native `fetch` (and the underlying undici client) rejects the cert,
 * which surfaces to our REST client as a `network` HueError.
 *
 * The standard workaround for local-network Hue API clients is to disable
 * certificate verification for these requests. The risk is contained:
 *
 * - The destination is a hard-configured LAN IP, never a public hostname, so
 *   a MITM would have to already be on the local network.
 * - The Hue API key only authorises light control — no broader system access
 *   leaks through a compromised channel.
 *
 * Loaded lazily via `require('undici')`: Node 18+ bundles undici and exposes
 * the `Agent` class without us having to take a runtime dependency on the
 * npm package. `@types/node` ships the undici type declarations.
 */

let cachedDispatcher: Dispatcher | undefined;
let attempted = false;

/**
 * Returns the insecure-TLS dispatcher, or `undefined` when undici cannot be
 * loaded (test environments where jest's module resolver doesn't see Node's
 * bundled undici). Callers must tolerate `undefined` and skip the dispatcher
 * option in that case — their unit-test mocks don't need it anyway.
 */
export function getHueDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher !== undefined) {
    return cachedDispatcher;
  }
  if (attempted) {
    return undefined;
  }
  attempted = true;
  try {
    // Node ships undici internally; the npm package name resolves to the same
    // runtime module without us adding an explicit dependency.
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
    const undici = require('undici') as {
      Agent: new (opts: { connect: { rejectUnauthorized: boolean } }) => Dispatcher;
    };
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
    cachedDispatcher = new undici.Agent({ connect: { rejectUnauthorized: false } });
    return cachedDispatcher;
  } catch {
    return undefined;
  }
}

/** RequestInit with the undici-specific dispatcher option that native fetch accepts. */
export interface HueRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}
