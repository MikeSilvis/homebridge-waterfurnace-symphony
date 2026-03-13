# homebridge-waterfurnace-symphony

Homebridge plugin for [WaterFurnace Symphony](https://symphony.mywaterfurnace.com/) geothermal systems.

Exposes each thermostat zone as a HomeKit Thermostat accessory with:
- Current temperature reading
- Heating and cooling setpoint control
- Mode control (Off / Heat / Cool / Auto)
- Humidity sensor

Supports IZ2 multi-zone systems (up to 6 zones).

## Installation

### From GitHub (recommended for now)

```bash
npm install -g git+https://github.com/MikeSilvis/homebridge-waterfurnace-symphony.git
```

Or via the Homebridge UI: go to Plugins, search custom repository, and enter the GitHub URL.

## Configuration

Add to your Homebridge `config.json` under `platforms`:

```json
{
  "platform": "WaterFurnaceSymphony",
  "name": "WaterFurnace",
  "email": "your-symphony-email@example.com",
  "password": "your-symphony-password",
  "zoneNames": {
    "z1": "Living Room",
    "z2": "Master Bedroom",
    "z3": "Upstairs",
    "z4": "Basement"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `platform` | Yes | Must be `WaterFurnaceSymphony` |
| `email` | Yes | Your symphony.mywaterfurnace.com login email |
| `password` | Yes | Your symphony.mywaterfurnace.com password |
| `zoneNames` | No | Custom display names for zones (z1-z6) |

## How It Works

The plugin connects to WaterFurnace's Symphony service using the same WebSocket API that powers their web dashboard. It authenticates with your account credentials, discovers your gateway and zones, and polls for updates every 15 seconds.

Temperature changes from HomeKit are sent as write commands over the WebSocket, with debouncing to avoid flooding when dragging sliders.

## Notes

- This uses an **undocumented API** — it could break if WaterFurnace changes their backend
- Your credentials are stored in the Homebridge config file in plaintext
- The WebSocket connection will automatically reconnect if it drops
