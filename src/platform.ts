import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME } from './settings';

/**
 * Smart Irrigation Homebridge platform.
 *
 * This is the Phase 1 scaffold: it loads cleanly inside Homebridge and logs its
 * lifecycle hooks, but exposes no accessories yet. Subsequent phases will add
 * the Hue client, weather sources, scheduler, pump orchestrator, and the
 * irrigation system accessory itself.
 */
export class SmartIrrigationPlatform implements DynamicPlatformPlugin {
  /**
   * Cached accessories restored from Homebridge's persistent storage. Empty in
   * Phase 1 because we do not register any accessories yet.
   */
  private readonly cachedAccessories: PlatformAccessory[] = [];

  public constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing %s platform (v%s scaffold)', PLATFORM_NAME, '0.1.0');

    this.api.on('didFinishLaunching', () => {
      this.log.info(
        '%s: didFinishLaunching — platform online, no accessories registered yet.',
        PLATFORM_NAME,
      );
    });

    this.api.on('shutdown', () => {
      this.log.info('%s: shutting down.', PLATFORM_NAME);
    });
  }

  /**
   * Homebridge invokes this for each accessory restored from disk on startup.
   * The Phase 1 scaffold simply tracks them so cached accessories survive the
   * load without being orphaned.
   */
  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring accessory from cache: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }
}
