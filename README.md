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

3. **Choose connection mode**: The plugin supports two connection modes:

   **Local Control (Recommended)**: Direct connection to your thermostat on your local network. No authentication required.

   **Cloud Control**: Connection via Lennox cloud API. Requires certificate extraction (see below).

4. Configure the plugin in Homebridge UI or `config.json`:

   **For Local Control (Recommended)**:

   ```json
   {
     "platforms": [
       {
         "name": "LennoxiComfort",
         "platform": "LennoxiComfort",
         "thermostatIP": "192.168.1.100",
         "connectionMode": "local",
         "pollingInterval": 60
       }
     ]
   }
   ```

   **For Cloud Control** (requires certificate extraction):

   First, extract the certificate from the Lennox mobile app:

   a. Set up a MITM proxy (e.g., mitmproxy, Charles Proxy, or Proxyman)
   b. Configure your device to use the proxy
   c. Log out and log back into the Lennox mobile app
   d. Capture the network traffic and find the request to `/v1/mobile/authenticate`
   e. Extract the certificate from the request body (it's a long base64-encoded string)

   See [CERTIFICATE_EXTRACTION.md](CERTIFICATE_EXTRACTION.md) for detailed instructions.

   Then set the certificate as an environment variable:

   ```bash
   export LENNOX_CERTIFICATE="your-extracted-certificate-here"
   ```

   And configure:

   ```json
   {
     "platforms": [
       {
         "name": "LennoxiComfort",
         "platform": "LennoxiComfort",
         "username": "your-email@example.com",
         "password": "your-password",
         "connectionMode": "cloud",
         "pollingInterval": 60
       }
     ]
   }
   ```

## Configuration

### Local Control Mode (Recommended)

- **thermostatIP** (required for local mode): IP address of your Lennox thermostat on your local network
  - To find your thermostat's IP address:
    - Check your router's DHCP client list
    - Use a network scanner app
    - Check the thermostat's network settings (if accessible)
- **connectionMode** (optional): Set to `"local"` to force local mode, `"cloud"` to force cloud mode, or `"auto"` (default) to auto-detect based on whether `thermostatIP` is provided
- **pollingInterval** (optional): How often to poll for status updates in seconds (default: 60, range: 30-300)
- **temperatureUnit** (optional): Temperature display unit - "auto" (uses system preference), "F", or "C" (default: "auto")

### Cloud Control Mode

- **username** (required for cloud mode): Your Lennox iComfort account email address
- **password** (required for cloud mode): Your Lennox iComfort account password
- **connectionMode** (optional): Set to `"cloud"` to force cloud mode, `"local"` to force local mode, or `"auto"` (default) to auto-detect
- **pollingInterval** (optional): How often to poll for status updates in seconds (default: 60, range: 30-300)
- **temperatureUnit** (optional): Temperature display unit - "auto" (uses system preference), "F", or "C" (default: "auto")
- **LENNOX_CERTIFICATE** (required for cloud mode): Environment variable containing the extracted certificate

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
- Certificate extraction required for cloud mode only (local mode does not require authentication)

## Troubleshooting

### Local Control Issues

**Cannot connect to thermostat:**

- Verify the thermostat IP address is correct
- Ensure the thermostat is on the same local network as Homebridge
- Check that the thermostat is powered on and connected to Wi-Fi
- Try pinging the thermostat IP address from the Homebridge server
- Check Homebridge logs for connection errors

**SSL certificate warnings:**

- Local connections use self-signed certificates, which is expected
- The plugin automatically accepts these certificates
- You may see warnings in logs, but these can be safely ignored

**Setpoint changes not working:**

- Verify the connection is established (check logs for "Connected to thermostat")
- Ensure the thermostat is not in a locked state
- Check Homebridge logs for command errors

### Cloud Control Issues

**Authentication Errors:**

If you encounter authentication errors:

1. Verify `LENNOX_CERTIFICATE` environment variable is set
2. Verify your username and password are correct
3. Check that your account has access to the iComfort system
4. Try extracting a fresh certificate if authentication fails (see [CERTIFICATE_EXTRACTION.md](CERTIFICATE_EXTRACTION.md))

**System Not Appearing:**

- Ensure your system is online and connected to the iComfort service
- Check Homebridge logs for error messages
- Verify your account has access to the system

### General Issues

**Temperature Not Updating:**

- Check the polling interval setting
- Verify network connectivity
- Check Homebridge logs for API errors
- For local mode, verify the connection is still active

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
