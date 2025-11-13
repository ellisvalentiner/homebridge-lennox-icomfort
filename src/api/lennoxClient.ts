import axios, { AxiosInstance } from 'axios';
import { LoginResponse, LennoxSystem, PublishCommandResponse, PublishMessage } from '../types';

export class LennoxClient {
  private api: AxiosInstance;
  private baseURL = 'https://gatewaymobile.prod4.myicomfort.com';
  private plantBaseURL = 'https://plantdevices.myicomfort.com';
  private publishBaseURL = 'https://publishapimobile.prod4.myicomfort.com';

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
   * Login with username and password
   * Note: This may require a certificate token first. If login fails, certificate auth may be needed.
   */
  async login(username: string, password: string, certificateToken?: string): Promise<LoginResponse> {
    const loginData = new URLSearchParams({
      username,
      password,
      grant_type: 'password',
      applicationid: `mapp${Date.now()}_${username}`,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Add certificate token if provided
    if (certificateToken) {
      headers['Authorization'] = certificateToken.startsWith('Bearer ') ? certificateToken : `Bearer ${certificateToken}`;
    }

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
        
        // If 401, might need certificate token
        if (status === 401) {
          throw new Error(`Login failed: Authentication required. Certificate token may be needed. (${status} ${statusText})`);
        }
        
        throw new Error(`Login failed: ${status} ${statusText}${data ? ` - ${JSON.stringify(data)}` : ''}`);
      }
      throw new Error(`Login failed: ${error.message}`);
    }
  }

  /**
   * Get all systems for the authenticated user
   */
  async getSystems(): Promise<LennoxSystem[]> {
    try {
      const sessionId = Math.floor(Date.now() / 1000);
      const response = await this.api.get<LennoxSystem[]>(
        `${this.plantBaseURL}/systems/`,
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
   */
  async publishCommand(message: PublishMessage, retries: number = 3): Promise<PublishCommandResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.api.post<PublishCommandResponse>(
          `${this.publishBaseURL}/v1/messages/publish`,
          message,
          {
            timeout: 30000,
          }
        );

        if (response.data.code !== 1) {
          throw new Error(`Command failed with code ${response.data.code}: ${response.data.message}`);
        }

        return response.data;
      } catch (error: any) {
        lastError = error;
        
        if (error.response) {
          const status = error.response.status;
          const statusText = error.response.statusText;
          
          // Don't retry on 401 (auth error) or 400 (bad request)
          if (status === 401 || status === 400) {
            throw new Error(`Failed to publish command: ${status} ${statusText}`);
          }
          
          // Retry on 5xx errors
          if (attempt < retries && status >= 500) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }
          
          throw new Error(`Failed to publish command: ${status} ${statusText}`);
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

