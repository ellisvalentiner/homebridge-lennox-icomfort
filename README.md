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

3. **Extract the certificate** (required for authentication):

   The plugin requires a certificate extracted from the Lennox mobile app. You'll need to:

   a. Set up a MITM proxy (e.g., mitmproxy, Charles Proxy, or Proxyman)
   b. Configure your device to use the proxy
   c. Log out and log back into the Lennox mobile app
   d. Capture the network traffic and find the request to `/v1/mobile/authenticate`
   e. Extract the certificate from the request body (it's a long base64-encoded string)

   See [CERTIFICATE_EXTRACTION.md](CERTIFICATE_EXTRACTION.md) for detailed instructions.

4. Set the certificate as an environment variable:

   ```bash
   export LENNOX_CERTIFICATE="your-extracted-certificate-here"
   ```

   Or add it to your Homebridge environment (e.g., in systemd service file or `.env` file).

5. Configure the plugin in Homebridge UI or `config.json`:

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
- Certificate extraction required for authentication (see [CERTIFICATE_EXTRACTION.md](CERTIFICATE_EXTRACTION.md))

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:

1. Verify `LENNOX_CERTIFICATE` environment variable is set
2. Verify your username and password are correct
3. Check that your account has access to the iComfort system
4. Try extracting a fresh certificate if authentication fails (see [CERTIFICATE_EXTRACTION.md](CERTIFICATE_EXTRACTION.md))

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
