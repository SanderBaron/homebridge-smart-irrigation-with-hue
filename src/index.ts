import type { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SmartIrrigationPlatform } from './platform';

/**
 * Plugin entry point. Homebridge invokes this default export with its public
 * API object and expects the platform to register itself.
 */
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SmartIrrigationPlatform);
};
