# Smart Irrigation with Hue

[![npm version](https://img.shields.io/npm/v/homebridge-smart-irrigation-with-hue.svg)](https://www.npmjs.com/package/homebridge-smart-irrigation-with-hue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Homebridge verified](https://badgen.net/badge/homebridge/verified/purple?icon=apple)](https://github.com/homebridge/homebridge)

Weather-aware, fully configurable Homebridge platform for an irrigation system built on **Philips Hue smart sockets**. Define any number of zones, run them on a sequenced schedule, and skip watering automatically when the wind or rain says so — all from a single Apple Home tile.

## Highlights

- **Zones**: 1 to N, each driving one Hue smart socket. Pick a type (sprinkler, drip line, micro-spray, mist, other) — the UI seeds sensible blocking defaults for it.
- **Schedule**: ordered steps (Zone → minutes → Zone → minutes …) with optional repeats. "20 min Noord → 20 min Oost → 20 min West, herhaal 2×" = a deterministic 120-minute cycle.
- **Run-with buddies**: per zone, pick which _other_ zones should water alongside whenever this zone is triggered. Models e.g. a drip line that rides along with every sprinkler.
- **Weather blocking**:
  - **Wind** — per-zone 8-octant compass mask + minimum wind speed.
  - **Rain** — per-zone "past 24 h" and "next 12 h" thresholds.
  - **Sources**: Open-Meteo (worldwide, ECMWF), Buienradar (Netherlands KNMI), OpenWeatherMap (optional, API key needed).
  - **Consensus**: any / majority / all of the active sources must agree.
- **Optional central pump** with configurable pre-run pressure build-up and post-run bleed-off.
- **Override switches in Apple Home**: per-zone, global, or off — user choice. Auto-reset after a configurable window.
- **"Run Schedule Now"** switch to fire the whole sequence on demand and a way to abort it mid-run.
- **Persistent state** that survives a Homebridge restart: the active schedule flag, today's fire log, manual overrides with their original expiry, and the last weather snapshot.
- **Custom Homebridge UI** — no raw JSON editing.

## Requirements

- Homebridge **2.0** or newer (HomeKit 4.x).
- Node.js **22** or **24**.
- A Philips Hue Bridge on the same LAN as Homebridge. v1 (BSB001/002) and v2 Pro (BSB003) bridges supported — the plugin uses the local Hue v1 REST API over HTTPS.
- One Hue smart socket per zone, and one for the pump if you have one.

## Installation

### Via the Homebridge UI (recommended)

1. Open the Homebridge UI in your browser (`http://<your-homebridge-host>:8581`).
2. Plugins → search for **Smart Irrigation with Hue** → Install.
3. Click the plugin's Settings — the custom UI opens; follow the **Setup** section below.

### From the command line

```bash
sudo npm install -g homebridge-smart-irrigation-with-hue
sudo hb-service restart
```

Then open the Homebridge UI and click the plugin's Settings.

## Setup

The custom UI has seven sections, top to bottom. Walk through them in order on first run.

### 1. Hue Bridge

1. Click **Find bridges** — mDNS auto-discovers any Hue Bridge on the LAN. If your network blocks mDNS, type the IP manually.
2. Click **Test connection** — the status dot should go green.
3. **Press the round button on top of the Hue Bridge**, then within 30 seconds click **Pair** in the UI. The plugin requests an API key from the bridge.
4. Once paired, the list of detected Hue lights/sockets fills the bottom of the section. You'll reference these by name when configuring zones.

### 2. Location

Decimal latitude/longitude (WGS84). Used by every weather source to look up local conditions. Display-only location name is optional.

### 3. Pump (optional)

Tick **Pump present** if your system has a central pump on a Hue smart socket. You'll set:

- **Outlet** — which Hue socket controls the pump.
- **Pre-run (sec)** — how long the pump runs before any valve opens, to build line pressure. Default 3.
- **Post-run (sec)** — how long the pump keeps running after the last valve closes, to bleed pressure. Default 5.
- **Served zones** — leave all selected for "every zone", or tick a subset.

### 4. Zones

Click **Add zone** for each watering area. Per zone:

- **Name** — shown in Apple Home (e.g. "Noord", "Voortuin").
- **Type** — sprinkler / drip line / micro-spray / mist / other. Picking a type loads sensible wind + rain blocking defaults for that hardware. You can override anything afterwards.
- **Hue outlet** — pick from the detected lights/sockets.
- **Run alongside this zone** — tick any _other_ zones that should automatically start when this zone starts (manual _or_ scheduled). Useful for e.g. a drip line that always rides along with whichever sprinkler is running.
- **Wind blocking** (optional) — minimum wind speed (m/s, stored internally; UI can show km/h, mph, knots or Beaufort) and which compass octants block the zone. Wind comes _from_ the ticked octant → zone won't fire when scheduled.
- **Rain skip** (optional) — past-24h and next-12h rainfall thresholds in mm. Either crossing → zone won't fire when scheduled.

### 5. Schedule

Click **Add entry** for each watering programme. Per entry:

- **Name** — free text.
- **Start time** — `HH:MM` (24-hour).
- **Days** — tick the days of the week the entry fires.
- **Steps** — the ordered sequence. Each step is one zone + a duration in minutes. Step 2 starts when step 1 finishes. Run-with buddies water _alongside_ each step automatically — you don't list them as separate steps.
- **Repeat** — how many times the whole sequence runs back-to-back. 1 = once, 2 = twice, etc.
- The UI shows an **Estimated total** that updates as you edit.

The "Activate Schedule" switch in Apple Home is the master enable: when **on**, entries fire on their configured days and times; when **off**, the schedule sits idle.

### 6. Weather & blocking

- **Sources**: tick the weather sources to consult. Open-Meteo and Buienradar are free and keyless; OpenWeatherMap requires an API key from openweathermap.org.
- **Consensus strategy**:
  - `any` — block if _any_ source reports a blocking condition.
  - `majority` — block when most active sources agree (default).
  - `all` — block only when _every_ active source agrees.
- **Cache (minutes)** — how long to memoise weather data between fetches. Default 10.
- **Override switches**:
  - `per-zone` — one wind switch + one rain switch _per zone_ in Apple Home.
  - `global` — one wind switch + one rain switch _total_.
  - `none` — no override switches; manual valve opens still bypass blocks.
- **Override auto-reset** — how long an enabled override stays on before snapping back. Default 60 min.
- **Wind unit (display)** — `m/s`, `km/h`, `mph`, `kts`, or `Bft`. Internal storage and calculations always use m/s; the unit only affects what the UI and logs show you.

### 7. Advanced

- **Log level** — `info` for normal use; `debug` while troubleshooting.
- **Hue health-check interval (sec)** — how often the platform probes the bridge. Default 60.

### Apple Home

After save + Homebridge restart, Apple Home picks up:

- A **Smart Irrigation with Hue** tile containing one Valve per zone (and the Irrigation System sub-services HomeKit needs).
- An **Activate Schedule** switch.
- A **Run Schedule Now** switch — momentary trigger that turns _on_ while a manual run is in progress, and that you can tap _off_ to abort.
- Zero, one, or many wind/rain **override** switches, depending on your granularity setting.

**Tip — display layout:** Apple Home sometimes renders the Irrigation System sub-services as ghost tiles if you choose "Include in a single tile". If you see unnamed irrigation tiles you can't tap, switch the tile to "Show as separate tile" instead.

## Troubleshooting

### The bridge probe fails with "Network error contacting Hue Bridge"

The bridge forces HTTPS with a self-signed certificate. The plugin disables certificate verification for the LAN-pinned bridge IP — this is expected and safe. If you still see the error, confirm the bridge IP is reachable (`ping`, `curl -sk https://<bridge-ip>/api/config` should return JSON).

### "Pairing failed (link-not-pressed)"

You didn't press the round button on the Hue Bridge within 30 seconds of clicking Pair. Try again — the plugin polls every 2 seconds.

### Scheduled entry doesn't fire on time

- Check **Activate Schedule** is **on** in Apple Home.
- Check the entry's day list includes today.
- Check the start time is in 24-hour `HH:MM` form.
- If you edited the start time _earlier today after it already fired_, restart Homebridge — the persistent "fired today" record is dropped on restart if its current start time is still in the future.

### Watering happens but the schedule never advances to the next step

Set log level to `debug` and watch the log. The scheduler logs `Schedule entry "<name>" firing at HH:MM` and one `Starting zone <name>` per step. If a step never starts, its zone may be weather-blocked — the log will say so.

### Hue Bridge unreachable: "closing all valves in plugin state"

The plugin's health check found the bridge unresponsive and closed every valve as a safety measure. Once the bridge comes back the log shows "Hue Bridge reachable again" and normal operation resumes.

### State file

State lives at `<homebridge-storage-path>/weather-smart-irrigation-state.json`. Deleting it resets the "fired today" record, manual overrides, and cached weather. The plugin recreates it on the next save.

## Roadmap

Out of scope for v1 — listed here so they don't get lost:

- i18n / multilingual UI (currently English only).
- Multi-pump support.
- Soil moisture sensor integration.
- Multi-location.
- ML-based irrigation optimisation.
- Non-Hue hardware backends (Shelly, Tasmota, Tuya, etc.).

## Contributing

Bug reports and pull requests welcome on [GitHub](https://github.com/SanderBaron/homebridge-smart-irrigation-with-hue/issues).

## License

[MIT](LICENSE) © Sander Baron
