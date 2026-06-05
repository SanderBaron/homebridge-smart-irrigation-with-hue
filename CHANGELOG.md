# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-06-05

### Changed

- **Weather status dashboard** — new "Current weather" panel at the top of the plugin settings UI. Shows live readings per source (wind speed/direction, rain past 24h, forecast 12h) and a per-zone decision table with measured values vs configured thresholds, vote tally, and a consensus badge. Auto-refreshes hourly; manual refresh button always available.
- **Hue device list collapsed** — the detected lights/sockets list is now folded by default (device count shown in the header). Only needs to be open during initial setup.
- **SetDuration persisted** — the valve duration you set in Apple Home is now saved to the state file and restored after a Homebridge restart, so it no longer resets to 5 minutes.
- **RemainingDuration countdown fixed** — the countdown timer in Apple Home now reflects the actual schedule duration (e.g. 20 min) instead of the HomeKit default SetDuration.

### Removed

- **Manual override subsystem removed** — weather blocking applies to the scheduled programme only. A manual valve open or "Run Schedule Now" always waters regardless of weather conditions. The wind/rain override switches in Apple Home are gone; no configuration needed.

### Fixed

- "Run Schedule Now" now bypasses weather blocking — pressing the button always runs the full schedule regardless of wind or rain conditions (both main steps and run-with buddies).

## [0.1.0] — 2026-06-02

Initial public release. Renamed the package to **homebridge-smart-irrigation-with-hue** ahead of npm publish. Bundles every feature delivered in phases 1–11 plus the post-Phase-11 polish, with one late refinement before launch: rain blocking is now a single global setting instead of per-zone, since rain falls equally on every zone of a single irrigation rig.

### Rain blocking is global (pre-launch refinement)

- New top-level `rain` config block (`enabled`, `past24hThresholdMm`, `next12hThresholdMm`) drives one rain decision for all zones.
- Wind blocking is still per zone — only rain moved.
- Single **Rain override** switch in Apple Home when rain blocking is enabled, regardless of override granularity (which now only governs wind).
- Migration: when a config still has v0.1-shape per-zone `rainBlocking` entries (no top-level `rain`), the parser takes the strictest (lowest non-zero) thresholds across all enabled per-zone entries to seed the global block. The UI client does the same so the migrated values show up in the form immediately.
- `evaluateRainBlocking(cfg, snapshots, strategy)` and `evaluateZoneBlocking(zone, rainCfg, snapshots, strategy)` reflect the new signatures.

### Added (since the spec)

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
- Persistent state (`src/state.ts`): single JSON file at `<homebridge-storage>/weather-smart-irrigation-state.json`. Atomic writes via temp+rename, tolerant load (missing file / malformed JSON / version mismatch all fall back to defaults), versioned schema for forward migrations, injectable filesystem for tests.
- Persisted fields: `scheduleActive`, `schedulerFiredToday` (per-entry date keys), per-zone wind/rain `overrides` (with original `expiresAt`), and the last `weatherSnapshots` so blocking decisions immediately after restart aren't running blind.
- Restore hooks: `Scheduler.restoreFiredToday` / `getFiredTodaySnapshot`, `OverrideManager.restore` (re-arms timers for the remaining time, drops already-expired entries, no `onChange` fired during rehydration), `TtlCache.set` to seed restored snapshots.
- Scheduler emits `onStateChange` when `setActive` flips or a `tick` fires an entry, so the platform persists state without polling.
- Platform persistence: load on bootstrap, save on schedule toggle / override change / weather refresh, save once more on shutdown (awaited so the file lands before Node exits). Saves are serialised through a promise chain to avoid concurrent temp-file writes.
- 13 new tests (StateStore load/save with malformed-file fallback, OverrideManager.restore semantics, Scheduler restoreFiredToday + onStateChange); total suite now 176.
- Custom Homebridge UI under `homebridge-ui/`:
  - `server.js` exposes `/discover-bridges`, `/probe-bridge`, `/pair-bridge`, `/list-lights` endpoints by delegating to the compiled `dist/hue/*` modules.
  - `public/index.html` lays out seven sections (Hue, Location, Pump, Zones, Schedule, Weather & blocking, Advanced) with all controls per the spec — no raw JSON editing.
  - `public/style.css` is vanilla, dark-mode aware via `prefers-color-scheme`, with status dots, card layout, modal, and sticky save bar.
  - `public/script.js` loads/serialises the typed config, renders dynamic zone + schedule lists, runs the pairing polling loop, validates before save, and confirms destructive actions.
  - `config.schema.json` now sets `customUi: true` so Homebridge loads the UI; the full schema for fallback hand-editing comes in Phase 10.
- Full `config.schema.json` describing every field `parseConfig` reads — `hue`, `location`, optional `pump`, `zones` (with nested `windBlocking` octant enum + `rainBlocking`), `schedule` (HH:MM regex + day enum), `weather`, `override`, `windUnit`, `logLevel`. Renders correctly in the Homebridge fallback form when `customUi` is unavailable, and provides validation hints for hand-editing `config.json`.
- Contract tests (`test/configSchema.test.ts`, 14 cases) assert the schema's `pluginAlias` matches `PLATFORM_NAME` and that every top-level property the parser knows about is advertised — so future parser fields don't silently outpace the schema. Total suite now 190.
- Phase 11 smoke-test on a live Homebridge 2.0.2 with a Hue Bridge Pro (BSB003) uncovered three real bugs and one UI rough edge, all now fixed:
  - **Modern Hue Bridges (BSB002 v2, BSB003 Pro) force HTTPS** on port 443 with a self-signed certificate; the previous `http://` URLs hit a 301 and then failed cert validation. New `src/hue/httpsAgent.ts` lazy-loads an undici `Agent` with `connect.rejectUnauthorized: false` and the client + pairing modules now use `https://` plus the dispatcher. `undici` added as a runtime dependency (Node ships it but jest's module resolver can't see the bundled copy).
  - **Theme detection in the custom UI** now reads the parent document's body classes first (`dark-mode` / `light-mode`), then `homebridge.serverEnv.theme`, then falls back to `prefers-color-scheme`. Critical text/background colours use `!important` to defeat any CSS the Homebridge UI X iframe wrapper may inject.
  - **Iframe scroll feedback loop** caused by `min-height: 100vh` on body interacting with the iframe-resizer: removed.
  - Cards no longer leave a wide white column to the side: `<body>` now spans 100% width with the dark theme colour.
- Test URLs updated to `https://` accordingly. Total suite still 190 tests, all green.
