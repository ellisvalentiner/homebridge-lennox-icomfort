# Certificate Extraction Guide

This plugin requires a certificate extracted from the Lennox mobile app's network traffic. This certificate is used for the initial authentication handshake.

## Why is this needed?

The Lennox iComfort API uses a two-step authentication process:

1. **Certificate Authentication**: Uses a certificate to obtain a certificate token
2. **User Authentication**: Uses the certificate token + username/password to obtain user tokens

The certificate must be extracted from the mobile app's network traffic.

## Prerequisites

- A device with the Lennox mobile app installed (iOS or Android)
- A MITM proxy tool (see options below)
- Basic understanding of network traffic inspection

## MITM Proxy Options

### Option 1: mitmproxy (Recommended - Free, Open Source)

- **Download**: https://mitmproxy.org/
- **Platform**: macOS, Linux, Windows
- **Pros**: Free, powerful, command-line and web interface
- **Setup**: https://docs.mitmproxy.org/stable/

### Option 2: Charles Proxy

- **Download**: https://www.charlesproxy.com/
- **Platform**: macOS, Windows, Linux
- **Pros**: User-friendly GUI, good documentation
- **Cons**: Free trial, paid license required

### Option 3: Proxyman (macOS only)

- **Download**: https://proxyman.io/
- **Platform**: macOS
- **Pros**: Modern UI, easy to use
- **Cons**: Free trial, paid license required

## Step-by-Step Instructions

### 1. Set Up MITM Proxy

1. Install your chosen MITM proxy tool
2. Start the proxy (usually runs on port 8080 or 8888)
3. Install the proxy's CA certificate on your device:
   - **mitmproxy**: Visit `mitm.it` on your device while connected to the proxy
   - **Charles**: Help → SSL Proxying → Install Charles Root Certificate
   - **Proxyman**: Follow the on-screen instructions

### 2. Configure Your Device

1. Connect your device to the same network as your computer
2. Configure your device's Wi-Fi to use a manual proxy:
   - **Server**: Your computer's IP address
   - **Port**: Proxy port (usually 8080 or 8888)
3. Verify the proxy is working by visiting a website on your device

### 3. Capture the Certificate

1. **Log out** of the Lennox mobile app completely (if logged in)
2. **Start capturing** network traffic in your MITM proxy
3. **Log in** to the Lennox mobile app with your credentials
4. **Stop capturing** after login completes

### 4. Find the Certificate Request

Look for a request with:

- **URL**: `https://gatewaymobile.prod4.myicomfort.com/v1/mobile/authenticate`
- **Method**: `POST`
- **Request Body**: A very long base64-encoded string (starts with `MII...`)

### 5. Extract the Certificate

The certificate is the **entire request body** of the `/v1/mobile/authenticate` request. It's a single long base64-encoded string.

**Example location in mitmproxy:**

- Select the request
- Go to the "Request" tab
- The certificate is the entire body content

**Example location in Charles:**

- Select the request
- Go to the "Request" tab
- View as "Text" or "Raw"
- Copy the entire body

### 6. Set the Environment Variable

Once you have the certificate, set it as an environment variable:

```bash
export LENNOX_CERTIFICATE="MIIKXAIBAzCCChgGCSqGSIb3DQEHAaCCCgkEggoFMIIKATCCBfoGCSqGSIb3DQEHAaCCBesEggXnMIIF4zCCBd8GCyqGSIb3DQEMCgECoIIE..."
```

**For Homebridge running as a service:**

If Homebridge runs as a systemd service, add the environment variable to the service file:

```bash
sudo systemctl edit homebridge
```

Add:

```ini
[Service]
Environment="LENNOX_CERTIFICATE=your-certificate-here"
```

Then restart:

```bash
sudo systemctl restart homebridge
```

**For Homebridge running via Docker:**

Add to your docker-compose.yml or docker run command:

```yaml
environment:
  - LENNOX_CERTIFICATE=your-certificate-here
```

## Troubleshooting

### "Certificate is required for authentication" Error

- Verify `LENNOX_CERTIFICATE` environment variable is set
- Check that the certificate string is complete (very long, starts with `MII`)
- Ensure there are no extra spaces or newlines in the certificate
- Restart Homebridge after setting the environment variable

### Certificate Authentication Fails

- The certificate may be device-specific or time-limited
- Try extracting a fresh certificate
- Ensure you captured the certificate from a fresh login (after logging out)
- Check that the certificate is the complete request body (not truncated)

### Can't Find the Request

- Make sure you logged out completely before capturing
- The request happens during login, so capture from the start of the login process
- Check that SSL/TLS proxying is enabled in your MITM tool
- Verify the proxy CA certificate is installed on your device

## Security Notes

- The certificate is used for authentication and should be kept secure
- We don't know if the certificate is shared, device-specific, or user-specific
- If authentication fails, you may need to extract a new certificate
- The certificate may change with app updates

## Alternative: Check if Certificate is Shared

If you have access to multiple devices or users, you can verify if the certificate is shared:

1. Extract certificate from Device/User A
2. Extract certificate from Device/User B
3. Compare: If identical → likely shared; if different → device/user-specific

If certificates are identical across devices/users, it's likely safe to share (but still treat with care).
