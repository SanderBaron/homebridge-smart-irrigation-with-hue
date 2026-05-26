import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PLATFORM_NAME } from '../src/settings';

/**
 * Lightweight contract tests for `config.schema.json`. The goal is not to
 * validate every JSON-Schema nuance — it's to make sure the schema stays in
 * sync with what {@link parseConfig} actually reads. If a new field is added
 * to the parser, this test reminds us to advertise it in the schema too.
 */

interface SchemaShape {
  pluginAlias?: string;
  pluginType?: string;
  singular?: boolean;
  customUi?: boolean;
  schema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const schemaPath = path.resolve(__dirname, '..', 'config.schema.json');
const schema: SchemaShape = JSON.parse(readFileSync(schemaPath, 'utf8')) as SchemaShape;

describe('config.schema.json — Homebridge metadata', () => {
  it('parses as JSON', () => {
    // Throwing parses would already have failed import; this test just
    // documents the requirement.
    expect(schema).toBeDefined();
  });

  it('declares the platform alias used by the parser', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });

  it('is a singular platform plugin with custom UI enabled', () => {
    expect(schema.pluginType).toBe('platform');
    expect(schema.singular).toBe(true);
    expect(schema.customUi).toBe(true);
  });
});

describe('config.schema.json — covers every parser field', () => {
  const props = schema.schema?.properties ?? {};

  it.each([
    'name',
    'hue',
    'location',
    'pump',
    'zones',
    'schedule',
    'weather',
    'override',
    'windUnit',
    'logLevel',
  ])('declares the %s top-level property', (key) => {
    expect(props).toHaveProperty(key);
  });

  it('marks location as required (latitude/longitude are mandatory)', () => {
    const required = schema.schema?.required ?? [];
    expect(required).toContain('location');
  });
});
