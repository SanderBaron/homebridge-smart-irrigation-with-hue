# homebridge-weather-smart-irrigation

[![npm version](https://img.shields.io/npm/v/homebridge-weather-smart-irrigation.svg)](https://www.npmjs.com/package/homebridge-weather-smart-irrigation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A weather-aware, fully configurable Homebridge platform plugin for irrigation systems
built on Philips Hue smart sockets. Define any number of zones, optionally orchestrate
a central pump, and automatically skip watering when wind or rain say so.

> **Status:** Early development (v0.1.0). Phase 1 scaffold only — see
> [CHANGELOG.md](CHANGELOG.md) for current capabilities.

## Features (roadmap)

- Dynamic zones with per-zone type, Hue outlet, concurrency group, wind- and rain-blocking.
- Optional central pump with configurable pre- and post-run timing.
- Day-of-week schedule with concurrency-aware planning.
- Per-zone wind direction blocking on 8 compass octants, plus minimum wind speed.
- Per-zone rain skip on past-24h + forecast-12h thresholds.
- Multi-source weather consensus (Open-Meteo, Buienradar, optional OpenWeatherMap).
- Globally selectable wind unit (m/s, km/h, mph, knots, Beaufort).
- Manual override switches in Apple Home with configurable auto-reset.
- Custom Homebridge configuration UI — no JSON editing required.

## Requirements

- Homebridge **2.0** or newer
- Node.js **22** or **24**
- A Philips Hue Bridge on the local network
- One Hue smart socket per zone (and one for the pump, if applicable)

## Installation

Once published to npm:

```bash
npm install -g homebridge-weather-smart-irrigation
```

Or install via the Homebridge UI by searching for `Smart Irrigation`.

## Configuration

Configuration is driven by the custom Homebridge UI (coming in a later phase).
For the current scaffold, add the platform to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "SmartIrrigation",
      "name": "Smart Irrigation"
    }
  ]
}
```

## Hue pairing flow

_To be documented when the Hue client lands in Phase 2._

## Troubleshooting

_To be documented._

## Hardware support

This plugin targets **Philips Hue smart sockets** via the local Hue Bridge REST API.
Support for other smart-plug ecosystems (Shelly, Tasmota, Tuya, etc.) is on the
roadmap but not in scope for v1.

## Roadmap (out of scope for v1)

- i18n / multilingual UI (Dutch and others)
- Multi-pump support
- Soil-moisture sensor integration
- Multi-location support
- ML-based irrigation optimisation
- Non-Hue hardware backends

## Contributing

Bug reports and pull requests are welcome on
[GitHub](https://github.com/SanderBaron/homebridge-weather-smart-irrigation/issues).

## License

[MIT](LICENSE) © Sander Baron
