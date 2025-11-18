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
   * Parse zone messages from Retrieve endpoint into substatuses
   * Handles PropertyChange messages with Data.zones containing status/period
   */
  private parseRetrieveMessagesToSubstatuses(messages: any[]): SubStatus[] {
    const substatuses: SubStatus[] = [];

    if (!Array.isArray(messages) || messages.length === 0) {
      this.log.debug('parseRetrieveMessagesToSubstatuses: No messages to parse');
      return substatuses;
    }

    this.log.debug(`parseRetrieveMessagesToSubstatuses: Processing ${messages.length} message(s)`);

    // Check if messages are nested under a 'messages' key
    let messagesToParse = messages;
    if (messages.length === 1 && messages[0].messages && Array.isArray(messages[0].messages)) {
      this.log.debug('parseRetrieveMessagesToSubstatuses: Detected nested messages structure');
      messagesToParse = messages[0].messages;
    }

    // Process each message to find zone data
    for (const message of messagesToParse) {
      if (!message || typeof message !== 'object') continue;

      // Look for PropertyChange messages with Data.zones
      if (message.MessageType === 'PropertyChange' && message.Data && message.Data.zones) {
        const zones = message.Data.zones;
        if (Array.isArray(zones)) {
          for (const zone of zones) {
            if (!zone || typeof zone !== 'object') continue;

            // Zone has status.period structure - convert to UserData
            if (zone.status && zone.status.period) {
              try {
                const status = zone.status;
                const period = zone.status.period;

                // Map period.systemMode to opMode
                let opMode: 'hc' | 'heat' | 'cool' | 'off' = 'off';
                if (period.systemMode === 'heat and cool') {
                  opMode = 'hc';
                } else if (period.systemMode === 'heat') {
                  opMode = 'heat';
                } else if (period.systemMode === 'cool') {
                  opMode = 'cool';
                }

                // Determine status from current state
                let statusValue: 'h' | 'c' | 'off' = 'off';
                if (status.heatCoast || (status.temperature && period.hsp && status.temperature < period.hsp)) {
                  statusValue = 'h';
                } else if (status.temperature && period.csp && status.temperature > period.csp) {
                  statusValue = 'c';
                }

                // Determine display units more reliably
                // First check if config explicitly sets the unit
                const configUnit = (this.config.temperatureUnit as string) || 'auto';
                let dispUnits: 'F' | 'C';
                
                if (configUnit === 'F' || configUnit === 'C') {
                  // Use explicit config setting
                  dispUnits = configUnit;
                  this.log.debug(`Using explicit temperature unit from config: ${dispUnits}`);
                } else {
                  // Auto-detect based on setpoint values
                  // Check setpoint values: typical Fahrenheit setpoints are 60-80, Celsius are 15-30
                  // Also check if hspC is provided and matches the expected conversion
                  dispUnits = 'F'; // Default to Fahrenheit (most common in US)
                  
                  if (period.hsp !== undefined && period.hspC !== undefined) {
                    // We have both Fahrenheit and Celsius setpoints
                    // Check if hspC matches the expected conversion from hsp
                    const expectedC = ((period.hsp - 32) * 5) / 9;
                    const hspCValue = parseFloat(String(period.hspC));
                    const diff = Math.abs(hspCValue - expectedC);
                    
                    // If the difference is small (< 2°C), hsp is in Fahrenheit
                    if (diff < 2) {
                      dispUnits = 'F';
                      this.log.debug(`Detected Fahrenheit: hsp=${period.hsp}, hspC=${hspCValue}, expectedC=${expectedC.toFixed(1)}, diff=${diff.toFixed(1)}`);
                    } else if (Math.abs(hspCValue - period.hsp) < 2) {
                      // If hspC is close to hsp, hsp is already in Celsius
                      dispUnits = 'C';
                      this.log.debug(`Detected Celsius: hsp=${period.hsp}, hspC=${hspCValue}`);
                    } else {
                      // Fallback: check setpoint range
                      if (period.hsp >= 50 && period.hsp <= 90) {
                        dispUnits = 'F';
                        this.log.debug(`Detected Fahrenheit by range: hsp=${period.hsp}`);
                      } else if (period.hsp >= 10 && period.hsp <= 35) {
                        dispUnits = 'C';
                        this.log.debug(`Detected Celsius by range: hsp=${period.hsp}`);
                      }
                    }
                  } else if (period.hsp !== undefined) {
                    // Only hsp available - use range heuristic
                    if (period.hsp >= 50 && period.hsp <= 90) {
                      dispUnits = 'F';
                      this.log.debug(`Detected Fahrenheit by range (hsp only): hsp=${period.hsp}`);
                    } else if (period.hsp >= 10 && period.hsp <= 35) {
                      dispUnits = 'C';
                      this.log.debug(`Detected Celsius by range (hsp only): hsp=${period.hsp}`);
                    }
                  } else if (status.temperature !== undefined) {
                    // Fallback: use temperature value heuristic
                    // Typical room temperature: 65-75°F or 18-24°C
                    if (status.temperature >= 50 && status.temperature <= 90) {
                      dispUnits = 'F';
                      this.log.debug(`Detected Fahrenheit by temperature: temp=${status.temperature}`);
                    } else if (status.temperature >= 10 && status.temperature <= 35) {
                      dispUnits = 'C';
                      this.log.debug(`Detected Celsius by temperature: temp=${status.temperature}`);
                    }
                  }
                }

                // Construct UserData object
                const userData: any = {
                  arr: false,
                  csp: String(period.csp || 0),
                  cspC: String(period.cspC || 0),
                  dband: 2,
                  dispUnits: dispUnits,
                  feelsLike: String(status.temperature || 0),
                  home: 'home',
                  hsp: String(period.hsp || 0),
                  hspC: String(period.hspC || 0),
                  id: zone.id !== undefined ? String(zone.id) : '0',
                  kind: 'zone',
                  maxCsp: 90,
                  maxCspC: '32',
                  maxHsp: 90,
                  maxHspC: '32',
                  minCsp: 50,
                  minCspC: '10',
                  minHsp: 40,
                  minHspC: '4',
                  numZones: 1,
                  occ: 'home',
                  opMode: opMode,
                  ot: status.temperature || 0,
                  otC: String(status.temperature || 0),
                  prdctType: 'thermostat',
                  rh: String(status.humidity || 0),
                  rsbusMode: 'auto',
                  schedNames: '',
                  ssp: period.startTime || 0,
                  sspC: String(period.startTime || 0),
                  sspMode: 'schedule',
                  status: statusValue,
                  sysName: 'Local Thermostat',
                  tstamp: new Date().toISOString(),
                  version: '1.0',
                  wsp: String(period.sp || 0),
                  zit: dispUnits === 'F' ? String(status.temperature || 0) : String(((status.temperature || 0) * 9/5) + 32),
                  zitC: dispUnits === 'C' ? String(status.temperature || 0) : String(((status.temperature || 0) - 32) * 5/9),
                  zoneNames: 'Zone 0',
                  zoningMode: 'single',
                  fanMode: period.fanMode || 'auto',
                };

                const userDataString = JSON.stringify(userData);
                const zoneId = zone.id !== undefined ? String(zone.id) : '0';
                const now = Date.now();
                const nowSeconds = Math.floor(now / 1000);
                const nowNanos = (now % 1000) * 1000000;

                substatuses.push({
                  relay_id: zoneId,
                  guid: zoneId,
                  dds_guid: zoneId,
                  active: true,
                  active_ts: {
                    sec: nowSeconds,
                    nanosec: nowNanos,
                  },
                  alive: true,
                  alive_ts: {
                    sec: nowSeconds,
                    nanosec: nowNanos,
                  },
                  user_data: userDataString,
                });
                this.log.debug(`parseRetrieveMessagesToSubstatuses: Created substatus for zone ${zoneId}`);
              } catch (error) {
                this.log.debug('parseRetrieveMessagesToSubstatuses: Failed to construct UserData from status/period:', error);
              }
            }
          }
        }
      }
    }

    this.log.debug(`parseRetrieveMessagesToSubstatuses: Returning ${substatuses.length} substatus(es)`);
    return substatuses;
  }

  /**
   * Remove old cloud accessories when switching to local mode
   */
  private removeOldCloudAccessories(): void {
    const lccUuid = this.api.hap.uuid.generate('LCC');
    const accessoriesToRemove: PlatformAccessory[] = [];

    // Find all accessories that aren't the local LCC system
    for (const accessory of this.accessories) {
      if (accessory.UUID !== lccUuid) {
        accessoriesToRemove.push(accessory);
      }
    }

    // Unregister and remove old accessories
    if (accessoriesToRemove.length > 0) {
      this.log.info(
        `Removing ${accessoriesToRemove.length} old cloud accessory(ies) in favor of local connection`
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);

      // Remove from our tracking arrays
      for (const accessory of accessoriesToRemove) {
        const index = this.accessories.indexOf(accessory);
        if (index > -1) {
          this.accessories.splice(index, 1);
        }
        // Remove handler reference
        this.accessoryHandlers.delete(accessory.UUID);
      }
    }
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

        // Remove old cloud accessories if any exist
        this.removeOldCloudAccessories();

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

        // Use RequestData + Retrieve pattern (matches Python lennoxs30api)
        // Step 1: RequestData publishes a request for zone data using JSONPath
        // Python uses: JSONPath "1;/zones" for local connections
        const additionalParams = '"AdditionalParameters":{"JSONPath":"1;/zones"}';

        let requestDataError: Error | null = null;
        try {
          await this.client.requestData('LCC', additionalParams);
          this.log.debug('RequestData succeeded, waiting for response messages...');
        } catch (error) {
          // If RequestData fails due to header validation, fall back to Retrieve only
          requestDataError = error instanceof Error ? error : new Error(String(error));
          this.log.warn(
            'RequestData failed, using Retrieve only:',
            requestDataError.message
          );
        }

        // Step 2: Retrieve messages to get PropertyChange messages with zone data
        // Wait a brief moment for the response to be available (if RequestData succeeded)
        if (!requestDataError) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        let messages: any[];
        try {
          messages = await this.client.retrieveMessages({
            longPollingTimeout: 10.0, // Longer timeout to wait for messages
            direction: 'Newest-to-Oldest', // Get most recent messages first
            messageCount: 50, // Get more messages to find zone data
            startTime: Math.floor(Date.now() / 1000) - 300, // Look back 5 minutes
          });
          this.log.debug(`Retrieved ${messages.length} message(s) from thermostat`);
        } catch (error) {
          this.log.error(
            'Failed to retrieve messages:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        // Parse zone messages into substatuses
        const substatuses = this.parseRetrieveMessagesToSubstatuses(messages);

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
            substatuses: substatuses,
          },
        };

        if (substatuses.length > 0) {
          this.log.info(`Parsed ${substatuses.length} zone(s) from Retrieve messages`);
        } else {
          this.log.warn('No zone data found in Retrieve messages - will retry during polling');
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
        // Local connection mode - use retrieveMessages for status updates
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

        // Use RequestData + Retrieve pattern (matches Python lennoxs30api)
        // Step 1: RequestData publishes a request for zone data using JSONPath
        const additionalParams = '"AdditionalParameters":{"JSONPath":"1;/zones"}';

        let requestDataError: Error | null = null;
        try {
          await this.client.requestData('LCC', additionalParams);
          this.log.debug('RequestData succeeded during polling, waiting for response messages...');
        } catch (error) {
          // If RequestData fails, fall back to Retrieve only
          requestDataError = error instanceof Error ? error : new Error(String(error));
          this.log.debug(
            'RequestData failed during polling (using Retrieve only):',
            requestDataError.message
          );
        }

        // Step 2: Retrieve messages to get PropertyChange messages with zone data
        // Wait a brief moment for the response to be available (if RequestData succeeded)
        if (!requestDataError) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        let messages: any[];
        try {
          messages = await this.client.retrieveMessages({
            longPollingTimeout: 10.0, // Longer timeout to wait for messages
            direction: 'Newest-to-Oldest', // Get most recent messages first
            messageCount: 50, // Get more messages to find zone data
            startTime: Math.floor(Date.now() / 1000) - 300, // Look back 5 minutes
          });
          this.log.debug(`Retrieved ${messages.length} message(s) during polling`);
        } catch (error) {
          this.log.error(
            'Failed to retrieve messages during polling:',
            error instanceof Error ? error.message : String(error)
          );
          return;
        }

        // Parse zone messages into substatuses
        const substatuses = this.parseRetrieveMessagesToSubstatuses(messages);

        // Create/update system object from response data
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
            substatuses: substatuses,
          },
        };

        if (substatuses.length > 0) {
          this.log.debug(`Parsed ${substatuses.length} zone(s) from Retrieve polling messages`);
        } else {
          this.log.warn('No zone data found in Retrieve polling messages');
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
