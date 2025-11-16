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
  public authManager: AuthManager; // Made public for accessory use
  private pollingInterval?: NodeJS.Timeout;
  private storagePath: string;
  private accessoryHandlers: Map<string, LennoxiComfortAccessory> = new Map();
  public readonly isLocalConnection: boolean; // Track connection mode

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    // Get storage path from Homebridge
    this.storagePath = path.join(this.api.user.storagePath(), 'homebridge-lennox-icomfort');

    // Determine connection mode
    const connectionMode = (this.config.connectionMode as string) || 'auto';
    const thermostatIP = this.config.thermostatIP as string | undefined;

    // Determine if we should use local connection
    if (connectionMode === 'local' || (connectionMode === 'auto' && thermostatIP)) {
      this.isLocalConnection = true;
      this.log.info(`Using local connection mode with thermostat IP: ${thermostatIP}`);

      if (!thermostatIP) {
        this.log.error('thermostatIP is required for local connection mode');
        throw new Error('thermostatIP is required for local connection mode');
      }

      // Initialize API client with thermostat IP for local connection
      this.client = new LennoxClient(thermostatIP);
    } else {
      this.isLocalConnection = false;
      this.log.info('Using cloud connection mode');

      // Initialize API client for cloud connection
      this.client = new LennoxClient();
    }

    // Initialize auth manager
    this.authManager = new AuthManager(this.client, this.storagePath);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // Run the method to discover / register your devices as accessories
      // Wrap in try-catch to prevent unhandled exceptions
      this.discoverDevices().catch((error) => {
        this.log.error(
          'Unhandled error in discoverDevices:',
          error instanceof Error ? error.message : String(error)
        );
      });
    });

    // Cleanup on shutdown
    this.api.on('shutdown', () => {
      this.log.debug('Shutting down platform');
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = undefined;
      }
      // Disconnect from thermostat if using local connection
      if (this.isLocalConnection) {
        this.client.disconnect().catch((error) => {
          this.log.warn(
            'Error disconnecting from thermostat:',
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      // Clear handler references
      this.accessoryHandlers.clear();
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
    try {
      if (this.isLocalConnection) {
        // Local connection mode
        this.log.info('Discovering Lennox iComfort systems via local connection...');

        // Connect to thermostat
        try {
          await this.client.connect();
          this.log.info('Connected to thermostat');
        } catch (error) {
          this.log.error(
            'Failed to connect to thermostat:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        // Request system data using RequestData endpoint
        // JSONPath matches lennoxs30api subscribe for local connections
        const additionalParams =
          '"AdditionalParameters":{"JSONPath":"1;/systemControl;/systemController;/reminderSensors;/reminders;/alerts/active;/alerts/meta;/bleProvisionDB;/ble;/indoorAirQuality;/fwm;/rgw;/devices;/zones;/equipments;/schedules;/occupancy;/system"}';

        let responseText: string;
        try {
          responseText = await this.client.requestData('LCC', additionalParams);
        } catch (error) {
          this.log.error(
            'Failed to request system data:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        // Parse response - it may be a JSON string or already parsed
        let responseData: any;
        try {
          responseData = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        } catch (parseError) {
          this.log.error(
            'Failed to parse system data response:',
            parseError instanceof Error ? parseError.message : String(parseError)
          );
          this.log.debug('Response text:', responseText);
          return;
        }

        // Create a minimal LennoxSystem object for local connections
        // The system ID is "LCC" for local connections
        const system: LennoxSystem = {
          id: 0,
          extId: 'LCC', // Local Control Center
          name: 'Local Thermostat',
          status: {
            relay_id: 'LCC',
            guid: 'LCC',
            arr: false,
            active: true,
            alive: true,
            substatuses: [], // Will be populated from response data if available
          },
        };

        // Try to extract status information from response if available
        // The response structure may vary, so we'll handle it gracefully
        if (responseData && typeof responseData === 'object') {
          // Store raw response data for later use in polling
          // We'll parse it more fully in pollSystems
          this.log.debug('Received system data from local connection');
        }

        this.log.info('Found local system: LCC');

        // Register the system as an accessory
        await this.registerSystem(system);

        // Start polling for updates
        this.startPolling();
      } else {
        // Cloud connection mode (existing logic)
        // Validate configuration - plugin must not start unless configured
        if (!this.config.username || !this.config.password) {
          this.log.error(
            'Username and password are required in configuration for cloud mode. Plugin will not start until configured.'
          );
          return;
        }

        // Check if certificate is available
        if (!process.env.LENNOX_CERTIFICATE) {
          this.log.error('LENNOX_CERTIFICATE environment variable is not set.');
          this.log.error(
            'Please set the LENNOX_CERTIFICATE environment variable with the certificate from request-response-payloads.txt line 17.'
          );
          this.log.error(
            'See HOMEBRIDGE_SETUP.md for instructions on how to set environment variables.'
          );
          return;
        }

        // Authenticate
        if (!this.authManager.isAuthenticated()) {
          this.log.info('Authenticating with Lennox iComfort...');
          try {
            await this.authManager.login(
              this.config.username as string,
              this.config.password as string
            );
            this.log.info('Authentication successful');
          } catch (error) {
            this.log.error(
              'Authentication failed:',
              error instanceof Error ? error.message : String(error)
            );
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
          this.log.error(
            'Failed to get authentication token:',
            error instanceof Error ? error.message : String(error)
          );
          this.log.info('Attempting to re-authenticate...');
          try {
            await this.authManager.login(
              this.config.username as string,
              this.config.password as string
            );
            token = await this.authManager.getToken();
            this.client.setAuthToken(token);
          } catch (retryError) {
            this.log.error(
              'Re-authentication failed:',
              retryError instanceof Error ? retryError.message : String(retryError)
            );
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
          this.log.error(
            'Failed to discover systems:',
            error instanceof Error ? error.message : String(error)
          );
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
      }
    } catch (error) {
      this.log.error(
        'Error discovering devices:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Register a system as a HomeKit accessory
   */
  async registerSystem(system: LennoxSystem): Promise<void> {
    const uuid = this.api.hap.uuid.generate(system.extId);
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (existingAccessory) {
      // The accessory already exists
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      const handler = new LennoxiComfortAccessory(this, existingAccessory, system);
      // Store handler reference in Map (not in context to avoid circular references)
      this.accessoryHandlers.set(uuid, handler);
    } else {
      // The accessory does not yet exist, so we need to create it
      this.log.info('Adding new accessory:', system.extId);

      // Create a new accessory
      const accessory = new this.api.platformAccessory(
        system.name || `Lennox System ${system.extId.substring(0, 8)}`,
        uuid
      );

      // Store a copy of the device object in the `accessory.context`
      // Only store serializable data, not handler instances
      accessory.context.system = system;

      // Create the accessory handler
      const handler = new LennoxiComfortAccessory(this, accessory, system);
      // Store handler reference in Map (not in context to avoid circular references)
      this.accessoryHandlers.set(uuid, handler);

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
      if (this.isLocalConnection) {
        // Local connection mode - use requestData for status updates
        if (!this.client.isConnected()) {
          this.log.warn('Not connected to thermostat, attempting to reconnect...');
          try {
            await this.client.connect();
            this.log.info('Reconnected to thermostat');
          } catch (error) {
            this.log.error(
              'Failed to reconnect to thermostat:',
              error instanceof Error ? error.message : String(error)
            );
            return;
          }
        }

        // Request status data using RequestData endpoint
        // JSONPath for zones/schedules/status (matches lennoxs30api)
        const additionalParams =
          '"AdditionalParameters":{"JSONPath":"1;/zones;/occupancy;/schedules;/reminderSensors;/reminders;/alerts/active;"}';

        let responseText: string;
        try {
          responseText = await this.client.requestData('LCC', additionalParams);
        } catch (error) {
          this.log.error(
            'Failed to request status data:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        // Parse response
        let responseData: any;
        try {
          responseData = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        } catch (parseError) {
          this.log.error(
            'Failed to parse status data response:',
            parseError instanceof Error ? parseError.message : String(parseError)
          );
          return;
        }

        // Create/update system object from response data
        // For now, we'll create a minimal system object and let the accessory handle parsing
        // The actual parsing of zones/schedules will be done in the accessory's updateStatus method
        const system: LennoxSystem = {
          id: 0,
          extId: 'LCC',
          name: 'Local Thermostat',
          status: {
            relay_id: 'LCC',
            guid: 'LCC',
            arr: false,
            active: true,
            alive: true,
            substatuses: [], // Will be populated from response if available
          },
        };

        // Try to extract substatuses from response if available
        // The response structure may contain zones with user_data
        if (responseData && typeof responseData === 'object') {
          // Parse zones if available
          if (responseData.zones && Array.isArray(responseData.zones)) {
            // Process zones to create substatuses
            // This is a simplified version - full parsing would extract user_data from each zone
            this.log.debug('Received zone data from local connection');
          }
        }

        // Update accessory with system data
        const uuid = this.api.hap.uuid.generate('LCC');
        const handler = this.accessoryHandlers.get(uuid);

        if (handler) {
          try {
            await handler.updateStatus(system);
          } catch (error) {
            this.log.warn(
              'Error updating status for local system:',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      } else {
        // Cloud connection mode (existing logic)
        let token: string;
        try {
          token = await this.authManager.getToken();
          this.client.setAuthToken(token);
        } catch (error) {
          this.log.warn('Token expired during polling, attempting to refresh...');
          // Try to re-authenticate
          if (this.config.username && this.config.password) {
            try {
              await this.authManager.login(
                this.config.username as string,
                this.config.password as string
              );
              token = await this.authManager.getToken();
              this.client.setAuthToken(token);
            } catch (authError) {
              this.log.error(
                'Re-authentication failed during polling:',
                authError instanceof Error ? authError.message : String(authError)
              );
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
          this.log.error(
            'Failed to fetch systems during polling:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        for (const system of systems) {
          const uuid = this.api.hap.uuid.generate(system.extId);
          const handler = this.accessoryHandlers.get(uuid);

          if (handler) {
            try {
              await handler.updateStatus(system);
            } catch (error) {
              this.log.warn(
                `Error updating status for system ${system.extId}:`,
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        }
      }
    } catch (error) {
      this.log.error(
        'Error polling systems:',
        error instanceof Error ? error.message : String(error)
      );
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
    let subStatus = system.status.substatuses.find((s) => s.active && s.alive);

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
      this.log.error(
        'Error parsing user_data:',
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }
}
