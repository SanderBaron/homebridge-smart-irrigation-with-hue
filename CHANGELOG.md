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
- Schedule types (`src/types.ts`): `WeekDay` (Sun-first to match `Date.getDay()`), `ScheduleEntry`.
- Scheduler (`src/scheduler.ts`):
  - Tick-driven engine that fires day-matching entries exactly once per local day.
  - Enforces concurrency: zones in the same group run together; different-group or standalone zones queue and run sequentially with conflicts logged.
  - Restart-safe: activating mid-day marks entries whose start time is already strictly past as "fired today" so a Homebridge restart never replays the morning's watering.
  - Optional `isZoneBlocked` hook for the weather blocking engine (Phase 4) — blocked zones are skipped, not queued.
  - `stopAll` for shutdown hooks; deactivating the scheduler does not interrupt currently running zones.
- 13 new tests; total suite now 135.
- Config parser (`src/config.ts`): `parseConfig` turns the raw Homebridge `PlatformConfig` into a strictly-typed `SmartIrrigationConfig`, applies defaults, drops malformed zones/entries, validates HH:MM times, scopes pump zone ids to known zones, and silently drops OpenWeatherMap from `weather.sources` when no API key is provided.
- TTL cache (`src/ttlCache.ts`): minimal one-value generic cache used by the platform to memoise the aggregated weather snapshot list.
- Override manager (`src/overrideManager.ts`): per-zone wind/rain override state with auto-reset timers, `onChange` callback for HomeKit sync, timer-renew semantics when re-activated, and `clearAllSilent` for shutdown.
- Accessory plan (`src/accessoryPlan.ts`): pure `computeValves` / `computeSwitches` projections from the parsed config — testable without Homebridge.
- Platform accessory (`src/platformAccessory.ts`): single `Irrigation System` accessory with dynamic Valve sub-services per zone and dynamic Switch services for the schedule + per-zone wind/rain overrides. Wires HomeKit characteristic events to Hue, pump, scheduler, and override manager. Removes stale services when zones/entries disappear from config.
- Platform orchestrator (`src/platform.ts`, rewritten from Phase 1 stub):
  - Parses config, instantiates Hue client / weather cache / pump / scheduler / override manager, builds the accessory.
  - Periodic timers: scheduler tick (30 s), Hue health check (configurable, default 60 s), weather refresh (configurable, default 10 min).
  - `isZoneBlocked` projection consulted by the scheduler — combines blocking-engine verdict with manual overrides.
  - Hue-offline detection closes every valve in plugin state and logs clearly.
  - Tolerant of an incomplete config (missing Hue pairing) so the platform still loads while the user is configuring it.
- 28 new tests (config parser, TTL cache, override manager, accessory plan) covering pure logic; total suite now 163. The accessory + platform wiring is verified manually in Phase 11.
