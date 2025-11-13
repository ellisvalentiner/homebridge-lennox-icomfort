import { LennoxClient } from './lennoxClient';
import { LoginResponse } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export interface TokenData {
  userToken: string;
  refreshToken: string;
  expiryTime: number;
  issueTime: number;
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
   */
  async login(username: string, password: string): Promise<void> {
    try {
      const response = await this.client.login(username, password);
      this.saveTokens(response);
    } catch (error) {
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
    
    this.tokenData = {
      userToken: token.encoded.replace(/^bearer\s+/i, ''),
      refreshToken: token.refreshToken.replace(/^bearer\s+/i, ''),
      expiryTime: token.expiryTime,
      issueTime: token.issueTime,
    };

    const tokenFile = path.join(this.storagePath, 'tokens.json');
    try {
      fs.mkdirSync(this.storagePath, { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify(this.tokenData, null, 2));
    } catch (error) {
      throw new Error(`Failed to save tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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


