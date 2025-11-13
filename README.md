# homebridge-lennox-icomfort

Homebridge plugin for Lennox iComfort thermostats. This plugin allows you to control your Lennox iComfort thermostat systems through HomeKit.

## Features

- **Full Thermostat Control**: Control temperature, heating/cooling modes, and setpoints
- **Temperature Monitoring**: Real-time temperature and humidity readings
- **Fan Control**: Control fan speed and mode (if supported by your system)
- **Auto-Discovery**: Automatically discovers all Lennox iComfort systems associated with your account
- **Primary Zone Support**: Currently supports the primary zone of each system

## Installation

1. Install Homebridge if you haven't already: [Homebridge Installation Guide](https://homebridge.io/w/getting-started)

2. Install this plugin from GitHub:

   ```bash
   npm install -g https://github.com/ellisvalentiner/homebridge-lennox-icomfort.git
   ```

   Or clone and build from source:

   ```bash
   git clone https://github.com/ellisvalentiner/homebridge-lennox-icomfort.git
   cd homebridge-lennox-icomfort
   npm install
   npm run build
   npm link
   ```

3. Configure the plugin in Homebridge UI or `config.json`:

   ```json
   {
     "platforms": [
       {
         "name": "LennoxiComfort",
         "platform": "LennoxiComfort",
         "username": "your-email@example.com",
         "password": "your-password",
         "pollingInterval": 60
       }
     ]
   }
   ```

## Configuration

- **username** (required): Your Lennox iComfort account email address
- **password** (required): Your Lennox iComfort account password
- **pollingInterval** (optional): How often to poll for status updates in seconds (default: 60, range: 30-300)
- **temperatureUnit** (optional): Temperature display unit - "auto" (uses system preference), "F", or "C" (default: "auto")

## Supported Features

### Thermostat Service

- Current Temperature
- Target Temperature
- Heating/Cooling Mode (Off, Heat, Cool, Auto)
- Current Heating/Cooling State
- Heating Threshold Temperature (for Auto mode)
- Cooling Threshold Temperature (for Auto mode)
- Current Relative Humidity
- Temperature Display Units

### Fan Service (if supported)

- Fan Active/Inactive
- Fan Rotation Speed

## Limitations

- Currently supports only the primary zone of each system
- Multi-zone support may be added in future versions
- Certificate-based authentication may be required in some cases (currently using simplified username/password approach)

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:

1. Verify your username and password are correct
2. Check that your account has access to the iComfort system
3. Some accounts may require certificate-based authentication (not yet implemented)

### System Not Appearing

- Ensure your system is online and connected to the iComfort service
- Check Homebridge logs for error messages
- Verify your account has access to the system

### Temperature Not Updating

- Check the polling interval setting
- Verify network connectivity
- Check Homebridge logs for API errors

## Development

To build from source:

```bash
npm install
npm run build
npm link
```

To watch for changes during development:

```bash
npm run watch
```

## License

Apache-2.0

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request on [GitHub](https://github.com/ellisvalentiner/homebridge-lennox-icomfort).

## Repository

This plugin is currently only available on GitHub:

- **GitHub**: <https://github.com/ellisvalentiner/homebridge-lennox-icomfort>
- **Issues**: <https://github.com/ellisvalentiner/homebridge-lennox-icomfort/issues>
