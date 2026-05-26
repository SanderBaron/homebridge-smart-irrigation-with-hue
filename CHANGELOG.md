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
- Weather layer (`src/weather/`):
  - Open-Meteo source: keyless ECMWF data, wind in m/s, past-24h + next-12h precipitation in a single call.
  - Buienradar source: live KNMI station feed, nearest-station selection via haversine, current wind + `rainFallLast24Hour`.
  - OpenWeatherMap source: parallel current + 5-day-forecast calls (free tier), partial-snapshot fallback when one call fails.
  - Consensus engine with `any` / `majority` / `all` strategies; abstaining sources are excluded by the caller and never pollute the vote.
  - Typed `WeatherError` for `timeout` / `network` / `http` / `protocol` / `config` kinds.
  - 33 unit tests; total suite now 63.
- Shared domain types (`src/types.ts`): `Zone`, `ZoneType`, `CompassOctant`, `WindUnit`, `WindBlockingConfig`, `RainBlockingConfig`.
- Unit converter (`src/unitConverter.ts`): bidirectional m/s ↔ km/h / mph / kts / Bft with the spec's exact factors. All internal storage stays in m/s; conversions happen only at the UI edge.
- Blocking engine (`src/blockingEngine.ts`):
  - `degreesToOctant` mapping wind bearings to one of N/NE/E/SE/S/SW/W/NW with N straddling the 0/360 boundary.
  - `evaluateWindBlocking` / `evaluateRainBlocking` produce per-source votes, abstain on missing metrics, then feed the consensus engine.
  - `evaluateZoneBlocking` combines both decisions for the platform layer.
- 46 new tests; total suite now 109.
- Pump orchestrator (`src/pumpOrchestrator.ts`):
  - Reference-counts active zones using the pump and toggles the pump socket via an injected `setPumpState` callback.
  - `requestPumpStart` resolves only after the pre-run delay so the caller can open valves against built-up pressure.
  - `releasePumpStop` schedules the post-run shutdown; a new request inside the window cancels the pending shutdown.
  - Coverage list defaults to "all zones" when empty; explicit list scopes the pump to specific zones.
  - `forceStop` for shutdown hooks; concurrent starts are serialised onto a single startup.
- 13 new tests using Jest fake timers; total suite now 122.
