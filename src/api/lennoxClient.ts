import axios, { AxiosInstance } from 'axios';
import { LoginResponse, LennoxSystem, PublishCommandResponse, PublishMessage, CertificateAuthResponse, UserResponse, RegisterLCCOwnerResponse } from '../types';
import { getCertificate } from './certificate';

export class LennoxClient {
  private api: AxiosInstance;
  private baseURL = 'https://ic3messaging.myicomfort.com'; // Matches lennoxs30api CLOUD_AUTHENTICATE_URL and CLOUD_LOGIN_URL
  private plantBaseURL = 'https://plantdevices.myicomfort.com';
  private publishBaseURL = 'https://icpublishapi.myicomfort.com'; // Matches lennoxs30api CLOUD_PUBLISH_URL
  private requestDataBaseURL = 'https://icrequestdataapi.myicomfort.com'; // Matches lennoxs30api CLOUD_REQUESTDATA_URL

  constructor() {
    this.api = axios.create({
      timeout: 30000,
      headers: {
        'Accept': '*/*',
        'App-Version': '4.38.0022',
        'Request-Channel': 'mobileapp',
        'App-Os': 'node',
        'App-Gen-Supported': 'u-app',
        'Accept-Language': 'en-US;q=1',
        'Content-Type': 'application/json',
        'User-Agent': 'lx_ic3_mobile_appstore/4.38.0022 (Node.js)',
        'Device': 'mobile',
      },
    });
  }

  /**
   * Set authorization token for requests
   */
  setAuthToken(token: string): void {
    this.api.defaults.headers.common['Authorization'] = `bearer ${token}`;
  }

  /**
   * Authenticate using certificate to obtain certificate token
   * This is the first step in the authentication flow.
   * 
   * The certificate is a base64-encoded certificate that appears in the request body.
   * Based on the network capture, this is sent as a raw string (not JSON).
   */
  async authenticate(certificate?: string): Promise<CertificateAuthResponse> {
    try {
      // Get certificate from parameter or certificate utility
      const cert = certificate || getCertificate();
      
      if (!cert) {
        throw new Error(
          'Certificate is required for authentication. ' +
          'Please extract the certificate from the network capture or provide it via configuration. ' +
          'Set the LENNOX_CERTIFICATE environment variable.'
        );
      }

      // Validate certificate format (should start with MII and be base64)
      if (!cert.startsWith('MII')) {
        throw new Error(
          'Certificate format appears invalid. Certificate should start with "MII" and be a base64-encoded string. ' +
          'Please verify you copied the entire certificate from request-response-payloads.txt line 17.'
        );
      }

      // The certificate authentication endpoint expects the certificate as the request body
      // Based on the network capture, it's sent as a raw string, not JSON
      // Note: The Content-Type may need to be adjusted based on actual API requirements
      const response = await this.api.post<CertificateAuthResponse>(
        `${this.baseURL}/v1/mobile/authenticate`,
        cert,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          transformRequest: [(data) => data], // Send as-is, don't JSON.stringify
        }
      );

      // Validate response
      if (!response.data?.serverAssigned?.security?.certificateToken) {
        throw new Error('Certificate authentication response missing certificate token');
      }

      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        const data = error.response.data;
        
        if (status === 401 || status === 400) {
          throw new Error(
            `Certificate authentication failed: ${status} ${statusText}. ` +
            `A valid certificate is required. The certificate may need to be extracted from the Lennox mobile app ` +
            `or from the network capture (request-response-payloads.txt line 17). ` +
            `Verify that LENNOX_CERTIFICATE environment variable is set correctly.` +
            (data ? ` Response: ${JSON.stringify(data)}` : '')
          );
        }
        
        throw new Error(`Certificate authentication failed: ${status} ${statusText}${data ? ` - ${JSON.stringify(data)}` : ''}`);
      }
      throw new Error(`Certificate authentication failed: ${error.message}`);
    }
  }

  /**
   * Login with username and password
   * Requires a certificate token in the Authorization header (obtained via authenticate() first).
   * 
   * Based on MITM capture, the request:
   * - Uses Authorization header with bearer certificate token
   * - Sends URL-encoded form data in the body
   * - Content-Type header says application/json (but body is form-encoded - matching app behavior)
   */
  async login(username: string, password: string, certificateToken?: string): Promise<LoginResponse> {
    if (!certificateToken) {
      throw new Error('Certificate token is required for login. Call authenticate() first to obtain it.');
    }

    const loginData = new URLSearchParams({
      username,
      password,
      grant_type: 'password',
      applicationid: `mapp${Date.now()}_${username}`,
    });

    // The body is form-encoded, so we need the correct Content-Type
    // Note: MITM log shows application/json, but that's likely a capture artifact
    // The server expects application/x-www-form-urlencoded for form data
    // Authorization header must use lowercase "bearer" for login endpoint (matches MITM)
    // Certificate token should already have prefix removed by auth.ts, but handle both cases
    const tokenOnly = certificateToken.replace(/^(Bearer|bearer)\s+/i, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `bearer ${tokenOnly}`, // Always use lowercase "bearer" for login
    };

    try {
      const response = await this.api.post<LoginResponse>(
        `${this.baseURL}/v2/user/login`,
        loginData.toString(),
        { headers }
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        const data = error.response.data;
        
        // If 401, certificate token may be invalid or expired
        if (status === 401) {
          throw new Error(
            `Login failed: Authentication required (${status} ${statusText}). ` +
            `The certificate token may be invalid or expired. Try re-authenticating. ` +
            `Also verify your username and password are correct.` +
            (data ? ` Response: ${JSON.stringify(data)}` : '')
          );
        }
        
        throw new Error(`Login failed: ${status} ${statusText}${data ? ` - ${JSON.stringify(data)}` : ''}`);
      }
      throw new Error(`Login failed: ${error.message}`);
    }
  }

  /**
   * Get user information
   * Requires user token in Authorization header (obtained via login).
   * 
   * Based on MITM capture, the request:
   * - Uses Authorization header with lowercase "bearer" + user token
   * - Returns user info including firstName, lastName, email, etc.
   */
  async getUser(): Promise<UserResponse> {
    try {
      // Get current auth token from defaults (set via setAuthToken)
      const currentAuth = this.api.defaults.headers.common['Authorization'] as string | undefined;
      if (!currentAuth) {
        throw new Error('User token is required. Call login() first to obtain it.');
      }

      // Ensure lowercase "bearer" for user endpoint (matches MITM)
      // Extract token (remove any "Bearer" or "bearer" prefix)
      const userToken = currentAuth.replace(/^(Bearer|bearer)\s+/i, '');
      
      const response = await this.api.get<UserResponse>(
        `${this.baseURL}/v1/user`,
        {
          headers: {
            'Authorization': `bearer ${userToken}`, // Lowercase "bearer" for user endpoint
          },
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        if (status === 401) {
          throw new Error(`Authentication failed. Token may have expired. (${status} ${statusText})`);
        }
        throw new Error(`Failed to get user info: ${status} ${statusText}`);
      }
      throw new Error(`Failed to get user info: ${error.message}`);
    }
  }

  /**
   * Register LCC owner to obtain JWT token for plantdevices endpoints
   * This must be called after login to get the token needed for /systems/ endpoint
   * 
   * Based on MITM capture, the request:
   * - POST to /auth/registerLCCOwner
   * - Body contains user email and user token
   * - Returns JWT token in response
   */
  async registerLCCOwner(email: string, userToken: string): Promise<RegisterLCCOwnerResponse> {
    try {
      // Extract token (remove any "Bearer" or "bearer" prefix)
      const tokenOnly = userToken.replace(/^(Bearer|bearer)\s+/i, '');
      
      const sessionId = Math.floor(Date.now() / 1000);
      const response = await this.api.post<RegisterLCCOwnerResponse>(
        `${this.plantBaseURL}/auth/registerLCCOwner`,
        {
          id: email,
          token: `bearer ${tokenOnly}`, // User token with "bearer" prefix
        },
        {
          headers: {
            'Device-Mod': 'Node.js',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
            'SessionID': sessionId.toString(),
            'User-Agent': `Node-4.38.0022_PROD-${sessionId}-Node.js`,
            'iOS-OS': '18.0',
            'Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            'App-Build': '4.38.0022_PROD',
            'User': email,
          },
          timeout: 30000,
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        if (status === 401) {
          throw new Error(`Registration failed: Authentication required (${status} ${statusText})`);
        }
        throw new Error(`Failed to register LCC owner: ${status} ${statusText}`);
      }
      throw new Error(`Failed to register LCC owner: ${error.message}`);
    }
  }

  /**
   * Get all systems for the authenticated user
   * Requires plant token (JWT) obtained via registerLCCOwner()
   */
  async getSystems(plantToken?: string): Promise<LennoxSystem[]> {
    try {
      // Use provided plant token or get from defaults
      let token: string;
      if (plantToken) {
        token = plantToken;
      } else {
        const currentAuth = this.api.defaults.headers.common['Authorization'] as string | undefined;
        if (!currentAuth) {
          throw new Error('Plant token is required. Call registerLCCOwner() first to obtain it.');
        }
        // Extract token (remove any "Bearer" or "bearer" prefix)
        token = currentAuth.replace(/^(Bearer|bearer)\s+/i, '');
      }
      
      const sessionId = Math.floor(Date.now() / 1000);
      const response = await this.api.get<LennoxSystem[]>(
        `${this.plantBaseURL}/systems/`,
        {
          headers: {
            'Authorization': `Bearer ${token}`, // Capital "Bearer" for systems endpoint, JWT token
            'Device-Mod': 'Node.js',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
            'SessionID': sessionId.toString(),
            'User-Agent': `Node-4.38.0022_PROD-${sessionId}-Node.js`,
            'iOS-OS': '18.0',
            'Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            'App-Build': '4.38.0022_PROD',
          },
          timeout: 30000,
        }
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText;
        if (status === 401) {
          throw new Error(`Authentication failed. Token may have expired. (${status} ${statusText})`);
        }
        throw new Error(`Failed to get systems: ${status} ${statusText}`);
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout while fetching systems');
      }
      throw new Error(`Failed to get systems: ${error.message}`);
    }
  }

  /**
   * Publish a command to the system
   * 
   * Matches lennoxs30api publishMessageHelper - uses publish endpoint directly
   */
  async publishCommand(message: PublishMessage, retries: number = 3): Promise<PublishCommandResponse> {
    let lastError: Error | null = null;
    
    // Get current auth token from defaults (set via setAuthToken)
    const currentAuth = this.api.defaults.headers.common['Authorization'] as string | undefined;
    if (!currentAuth) {
      throw new Error('User token is required. Call login() first to obtain it.');
    }

    // Extract token (remove any "Bearer" or "bearer" prefix)
    const userToken = currentAuth.replace(/^(Bearer|bearer)\s+/i, '');
    
    // Use publish endpoint directly (matches lennoxs30api publishMessageHelper)
    const endpoint = `${this.publishBaseURL}/v1/messages/publish`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.api.post<PublishCommandResponse>(
          endpoint,
          message,
          {
            headers: {
              'Authorization': `bearer ${userToken}`, // Lowercase "bearer" matches lennoxs30api
              'Content-Type': 'application/json',
              'Accept': '*/*',
              'Accept-Language': 'en-US;q=1',
            },
            timeout: 30000,
          }
        );

        // Validate response code (1 = success)
        if (response.data.code !== 1) {
          const errorMsg = `Command failed with code ${response.data.code}: ${response.data.message || 'Unknown error'}`;
          throw new Error(errorMsg);
        }

        return response.data;
      } catch (error: any) {
        lastError = error;
        
        if (error.response) {
          const status = error.response.status;
          const statusText = error.response.statusText;
          const responseData = error.response.data;
          
          // Include response data in error message for debugging
          const errorDetails = responseData ? ` - ${JSON.stringify(responseData)}` : '';
          
          // Don't retry on 401 (auth error) or 400 (bad request)
          if (status === 401 || status === 400) {
            throw new Error(`Failed to publish command: ${status} ${statusText}${errorDetails}`);
          }
          
          // Retry on 5xx errors
          if (attempt < retries && status >= 500) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }
          
          throw new Error(`Failed to publish command: ${status} ${statusText}${errorDetails}`);
        }
        
        // Network error - retry
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      }
    }
    
    throw lastError || new Error('Failed to publish command after retries');
  }
}

