import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LennoxiComfortAccessory } from './thermostatAccessory';
import { LennoxClient } from './api/lennoxClient';
import { AuthManager } from './api/auth';
import { LennoxSystem, UserData, SubStatus } from './types';
import * as path from 'path';

/**
 * HomebridgePlatform
 * This class is the main constructor for the platform
 */
export class LennoxiComfortPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // This is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public client: LennoxClient;
  private authManager: AuthManager;
  private pollingInterval?: NodeJS.Timeout;
  private storagePath: string;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // Get storage path from Homebridge
    this.storagePath = path.join(this.api.user.storagePath(), 'homebridge-lennox-icomfort');

    // Initialize API client and auth manager
    this.client = new LennoxClient();
    this.authManager = new AuthManager(this.client, this.storagePath);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // Run the method to discover / register your devices as accessories
      // Wrap in try-catch to prevent unhandled exceptions
      this.discoverDevices().catch((error) => {
        this.log.error('Unhandled error in discoverDevices:', error instanceof Error ? error.message : String(error));
      });
    });

    // Cleanup on shutdown
    this.api.on('shutdown', () => {
      this.log.debug('Shutting down platform');
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = undefined;
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // Add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(): Promise<void> {
    // Validate configuration - plugin must not start unless configured
    if (!this.config.username || !this.config.password) {
      this.log.error('Username and password are required in configuration. Plugin will not start until configured.');
      return;
    }

    try {
      // Check if certificate is available
      if (!process.env.LENNOX_CERTIFICATE) {
        this.log.error('LENNOX_CERTIFICATE environment variable is not set.');
        this.log.error('Please set the LENNOX_CERTIFICATE environment variable with the certificate from request-response-payloads.txt line 17.');
        this.log.error('See HOMEBRIDGE_SETUP.md for instructions on how to set environment variables.');
        return;
      }

      // Authenticate
      if (!this.authManager.isAuthenticated()) {
        this.log.info('Authenticating with Lennox iComfort...');
        try {
          await this.authManager.login(this.config.username as string, this.config.password as string);
          this.log.info('Authentication successful');
        } catch (error) {
          this.log.error('Authentication failed:', error instanceof Error ? error.message : String(error));
          this.log.error('Please check:');
          this.log.error('  1. LENNOX_CERTIFICATE environment variable is set correctly');
          this.log.error('  2. Username and password in the configuration are correct');
          this.log.error('  3. Certificate is not expired (extract a fresh one if needed)');
          return;
        }
      }

      let token: string;
      try {
        token = await this.authManager.getToken();
        this.client.setAuthToken(token);
      } catch (error) {
        this.log.error('Failed to get authentication token:', error instanceof Error ? error.message : String(error));
        this.log.info('Attempting to re-authenticate...');
        try {
          await this.authManager.login(this.config.username as string, this.config.password as string);
          token = await this.authManager.getToken();
          this.client.setAuthToken(token);
        } catch (retryError) {
          this.log.error('Re-authentication failed:', retryError instanceof Error ? retryError.message : String(retryError));
          return;
        }
      }

      // Discover systems
      this.log.info('Discovering Lennox iComfort systems...');
      let systems: LennoxSystem[];
      try {
        // Get plant token for systems endpoint
        const plantToken = await this.authManager.getPlantToken();
        systems = await this.client.getSystems(plantToken);
      } catch (error) {
        this.log.error('Failed to discover systems:', error instanceof Error ? error.message : String(error));
        return;
      }

      if (systems.length === 0) {
        this.log.warn('No systems found');
        return;
      }

      this.log.info(`Found ${systems.length} system(s)`);

      // Register each system as an accessory
      for (const system of systems) {
        await this.registerSystem(system);
      }

      // Start polling for updates
      this.startPolling();

    } catch (error) {
      this.log.error('Error discovering devices:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Register a system as a HomeKit accessory
   */
  async registerSystem(system: LennoxSystem): Promise<void> {
    const uuid = this.api.hap.uuid.generate(system.extId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      // The accessory already exists
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new LennoxiComfortAccessory(this, existingAccessory, system);
    } else {
      // The accessory does not yet exist, so we need to create it
      this.log.info('Adding new accessory:', system.extId);

      // Create a new accessory
      const accessory = new this.api.platformAccessory(
        system.name || `Lennox System ${system.extId.substring(0, 8)}`,
        uuid,
      );

      // Store a copy of the device object in the `accessory.context`
      accessory.context.system = system;

      // Create the accessory handler
      new LennoxiComfortAccessory(this, accessory, system);

      // Link the accessory to your platform
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

      // Push into cached accessories
      this.accessories.push(accessory);
    }
  }

  /**
   * Start polling for system status updates
   */
  private startPolling(): void {
    const interval = (this.config.pollingInterval as number) || 60;
    this.log.info(`Starting status polling every ${interval} seconds`);

    // Poll immediately
    this.pollSystems();

    // Then poll at interval
    this.pollingInterval = setInterval(() => {
      this.pollSystems();
    }, interval * 1000);
  }

  /**
   * Poll all systems for status updates
   */
  private async pollSystems(): Promise<void> {
    try {
      let token: string;
      try {
        token = await this.authManager.getToken();
        this.client.setAuthToken(token);
      } catch (error) {
        this.log.warn('Token expired during polling, attempting to refresh...');
        // Try to re-authenticate
        if (this.config.username && this.config.password) {
          try {
            await this.authManager.login(this.config.username as string, this.config.password as string);
            token = await this.authManager.getToken();
            this.client.setAuthToken(token);
          } catch (authError) {
            this.log.error('Re-authentication failed during polling:', authError instanceof Error ? authError.message : String(authError));
            return;
          }
        } else {
          this.log.error('Cannot re-authenticate: username/password not configured');
          return;
        }
      }

      let systems: LennoxSystem[];
      try {
        // Get plant token for systems endpoint
        const plantToken = await this.authManager.getPlantToken();
        systems = await this.client.getSystems(plantToken);
      } catch (error) {
        this.log.error('Failed to fetch systems during polling:', error instanceof Error ? error.message : String(error));
        return;
      }

      for (const system of systems) {
        const uuid = this.api.hap.uuid.generate(system.extId);
        const accessory = this.accessories.find(acc => acc.UUID === uuid);

        if (accessory) {
          const handler = accessory.context.handler as LennoxiComfortAccessory;
          if (handler) {
            try {
              await handler.updateStatus(system);
            } catch (error) {
              this.log.warn(`Error updating status for system ${system.extId}:`, error instanceof Error ? error.message : String(error));
            }
          }
        }
      }
    } catch (error) {
      this.log.error('Error polling systems:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Get primary zone data from system
   */
  getPrimaryZoneData(system: LennoxSystem): { userData: UserData; subStatus: SubStatus } | null {
    if (!system.status || !system.status.substatuses || system.status.substatuses.length === 0) {
      return null;
    }

    // Find active/alive substatus first
    let subStatus = system.status.substatuses.find(s => s.active && s.alive);

    // Fallback to first substatus if no active one found
    if (!subStatus) {
      subStatus = system.status.substatuses[0];
    }

    if (!subStatus || !subStatus.user_data) {
      return null;
    }

    try {
      const userData = JSON.parse(subStatus.user_data) as UserData;
      return { userData, subStatus };
    } catch (error) {
      this.log.error('Error parsing user_data:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
}

