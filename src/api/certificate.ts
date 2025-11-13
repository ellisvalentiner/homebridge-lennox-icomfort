/**
 * Certificate handling for Lennox iComfort authentication
 * 
 * The certificate authentication requires a base64-encoded certificate.
 * This is a Microsoft Strong Cryptographic Provider certificate extracted from
 * the Lennox mobile app's network traffic via MITM capture.
 * 
 * SECURITY NOTE - UNKNOWN PROPERTIES:
 * We do NOT know for certain if this certificate is:
 * - Shared across all app instances (likely, but unverified)
 * - Device-specific (possible, but unverified)
 * - User-specific (unlikely, but unverified)
 * - Time-limited or expiring (unknown)
 * - Revocable by Lennox (unknown)
 * 
 * What we DO know:
 * - It's required for the initial authentication handshake
 * - It's embedded in or used by the mobile app
 * - It's extractable via MITM capture
 * - It's a Microsoft Strong Cryptographic Provider certificate
 * 
 * RECOMMENDATION:
 * - Treat as potentially sensitive until verified
 * - Can be overridden via LENNOX_CERTIFICATE environment variable
 * - Monitor for authentication failures that might indicate certificate issues
 */

/**
 * Get the certificate for authentication
 * 
 * The certificate MUST be provided via the LENNOX_CERTIFICATE environment variable.
 * This certificate is required for authentication and must be extracted from a MITM
 * capture of the Lennox mobile app's network traffic.
 * 
 * @returns The base64-encoded certificate string
 * @throws Error if certificate is not provided
 */
export function getCertificate(): string {
  const envCert = process.env.LENNOX_CERTIFICATE;
  
  if (!envCert) {
    throw new Error(
      'Certificate is required for authentication. ' +
      'Please set the LENNOX_CERTIFICATE environment variable. ' +
      'See README.md for instructions on how to extract the certificate from the Lennox mobile app.'
    );
  }
  
  return envCert;
}

