import { LennoxClient } from './lennoxClient';
import { LoginResponse } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export interface TokenData {
  userToken: string;
  refreshToken: string;
  expiryTime: number;
  issueTime: number;
  certificateToken?: string;
  certificateTokenExpiry?: number;
}

export class AuthManager {
  private client: LennoxClient;
  private storagePath: string;
  private tokenData: TokenData | null = null;

  constructor(client: LennoxClient, storagePath: string) {
    this.client = client;
    this.storagePath = storagePath;
    this.loadTokens();
  }

  /**
   * Login with username and password
   * This performs a two-step authentication:
   * 1. First obtains a certificate token via certificate authentication
   * 2. Then uses the certificate token to login with username/password
   */
  async login(username: string, password: string): Promise<void> {
    try {
      // Step 1: Get certificate token (if needed or expired)
      let certificateToken: string | undefined;
      
      if (!this.tokenData?.certificateToken || this.isCertificateTokenExpired()) {
        try {
          // Get certificate token via certificate authentication
          // This must be done before username/password login
          const certAuthResponse = await this.client.authenticate();
          const certToken = certAuthResponse.serverAssigned.security.certificateToken;
          
          if (!certToken || !certToken.encoded) {
            throw new Error('Certificate authentication response missing token');
          }
          
          // Extract the token (remove 'bearer ' prefix if present)
          certificateToken = certToken.encoded.replace(/^bearer\s+/i, '');
          
          // Store certificate token
          if (!this.tokenData) {
            this.tokenData = {
              userToken: '',
              refreshToken: '',
              expiryTime: 0,
              issueTime: 0,
            };
          }
          this.tokenData.certificateToken = certificateToken;
          this.tokenData.certificateTokenExpiry = certToken.expiryTime;
          this.saveTokensToDisk();
        } catch (certError) {
          const errorMessage = certError instanceof Error ? certError.message : 'Unknown error';
          throw new Error(
            `Certificate authentication failed: ${errorMessage}. ` +
            `This is the first step of authentication. Please check if the certificate is valid and not expired. ` +
            `Verify that LENNOX_CERTIFICATE environment variable is set correctly.`
          );
        }
      } else {
        certificateToken = this.tokenData.certificateToken;
      }

      if (!certificateToken) {
        throw new Error('Certificate token is missing after authentication');
      }

      // Step 2: Login with username/password using certificate token
      try {
        const response = await this.client.login(username, password, certificateToken);
        this.saveTokens(response);
      } catch (loginError) {
        const errorMessage = loginError instanceof Error ? loginError.message : 'Unknown error';
        throw new Error(
          `User login failed: ${errorMessage}. ` +
          `Please verify your username and password are correct.`
        );
      }
    } catch (error) {
      // Re-throw if already formatted, otherwise wrap
      if (error instanceof Error && (error.message.includes('Certificate authentication failed') || error.message.includes('User login failed'))) {
        throw error;
      }
      throw new Error(`Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get current user token, refreshing if necessary
   */
  async getToken(): Promise<string> {
    if (!this.tokenData) {
      throw new Error('Not authenticated. Please login first.');
    }

    // Check if token is expired or will expire in the next 5 minutes
    const now = Date.now() / 1000;
    if (this.tokenData.expiryTime - now < 300) {
      await this.refreshToken();
    }

    return this.tokenData.userToken;
  }

  /**
   * Refresh the user token using refresh token
   */
  async refreshToken(): Promise<void> {
    if (!this.tokenData || !this.tokenData.refreshToken) {
      throw new Error('No refresh token available. Please login again.');
    }

    try {
      // TODO: Implement token refresh API call when available
      // For now, we'll need to re-login if token expires
      throw new Error('Token refresh not yet implemented. Please re-login.');
    } catch (error) {
      // If refresh fails, clear tokens and require re-login
      this.clearTokens();
      throw new Error('Token refresh failed. Please login again.');
    }
  }

  /**
   * Save tokens to disk
   */
  private saveTokens(loginResponse: LoginResponse): void {
    const token = loginResponse.ServerAssignedRoot.serverAssigned.security.userToken;
    
    // Preserve certificate token if it exists
    const existingCertToken = this.tokenData?.certificateToken;
    const existingCertTokenExpiry = this.tokenData?.certificateTokenExpiry;
    
    this.tokenData = {
      userToken: token.encoded.replace(/^bearer\s+/i, ''),
      refreshToken: token.refreshToken.replace(/^bearer\s+/i, ''),
      expiryTime: token.expiryTime,
      issueTime: token.issueTime,
      certificateToken: existingCertToken,
      certificateTokenExpiry: existingCertTokenExpiry,
    };

    this.saveTokensToDisk();
  }

  /**
   * Save tokens to disk (internal helper)
   */
  private saveTokensToDisk(): void {
    if (!this.tokenData) {
      return;
    }

    const tokenFile = path.join(this.storagePath, 'tokens.json');
    try {
      fs.mkdirSync(this.storagePath, { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify(this.tokenData, null, 2));
    } catch (error) {
      throw new Error(`Failed to save tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if certificate token is expired
   */
  private isCertificateTokenExpired(): boolean {
    if (!this.tokenData?.certificateTokenExpiry) {
      return true;
    }
    
    // Check if token is expired or will expire in the next 5 minutes
    const now = Date.now() / 1000;
    return this.tokenData.certificateTokenExpiry - now < 300;
  }

  /**
   * Load tokens from disk
   */
  private loadTokens(): void {
    const tokenFile = path.join(this.storagePath, 'tokens.json');
    try {
      if (fs.existsSync(tokenFile)) {
        const data = fs.readFileSync(tokenFile, 'utf8');
        this.tokenData = JSON.parse(data);
      }
    } catch (error) {
      // Ignore errors loading tokens - will require re-login
      this.tokenData = null;
    }
  }

  /**
   * Clear stored tokens
   */
  private clearTokens(): void {
    this.tokenData = null;
    const tokenFile = path.join(this.storagePath, 'tokens.json');
    try {
      if (fs.existsSync(tokenFile)) {
        fs.unlinkSync(tokenFile);
      }
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.tokenData !== null;
  }
}


