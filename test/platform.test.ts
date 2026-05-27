import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';

describe('plugin identifiers', () => {
  it('exposes the platform alias used in config.schema.json', () => {
    expect(PLATFORM_NAME).toBe('SmartIrrigation');
  });

  it('exposes the npm package name used by Homebridge', () => {
    expect(PLUGIN_NAME).toBe('homebridge-smart-irrigation-with-hue');
  });
});
