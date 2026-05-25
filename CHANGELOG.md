# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial project scaffold: TypeScript strict mode, ESLint, Prettier, Jest, GitHub Actions CI.
- Platform stub registering as `SmartIrrigation` so Homebridge can load the plugin without errors.
- Minimal `config.schema.json` placeholder until the custom UI lands in a later phase.
- Hue Bridge layer (`src/hue/`):
  - mDNS discovery via `bonjour-service` with cloud-discovery fallback to `https://discovery.meethue.com/`.
  - Pairing flow that distinguishes "link button not pressed" (Hue error 101) from other failures.
  - REST client covering `getConfig`, `getLights`, `setLightOn`, and `healthCheck` with timeouts, retries on transient failures, and typed `HueError` for unauthorized / protocol / http / timeout / network cases.
  - 28 unit tests covering success and failure paths for all three modules.
