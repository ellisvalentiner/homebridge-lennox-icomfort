import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';

import { LennoxiComfortPlatform } from './platform';
import { LennoxSystem, UserData, PublishMessage, ScheduleCommand, ZoneHoldCommand } from './types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 */
export class LennoxiComfortAccessory {
  private thermostatService: Service;
  private fanService?: Service;

  private currentTemperature = 20;
  private targetTemperature = 20;
  private targetHeatingCoolingState = 0;
  private currentHeatingCoolingState = 0;
  private coolingThresholdTemperature = 25;
  private heatingThresholdTemperature = 20;
  private currentRelativeHumidity = 0;
  private temperatureDisplayUnits = 0; // 0 = Celsius, 1 = Fahrenheit
  private fanActive = false;
  private fanRotationSpeed = 0;

  private systemId: string;
  private senderId: string;
  private currentZoneScheduleId: number | null = null; // Current schedule ID from zone (discovered from system data)
  private currentStartTime: number | null = null; // Current startTime from zone (discovered from system data)
  private updateInProgress: boolean = false; // Lock to prevent concurrent updates

  constructor(
    private readonly platform: LennoxiComfortPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly system: LennoxSystem,
  ) {
    this.systemId = system.extId;
    // SenderID format matches app: mapp{timestamp}_{email}
    // The timestamp appears to be a long integer, and username should be the email
    this.senderId = `mapp${Date.now()}_${this.platform.config.username || 'user'}`;

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lennox')
      .setCharacteristic(this.platform.Characteristic.Model, 'iComfort')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, system.extId);

    // Get or create the Thermostat service
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    // Set service name
    this.thermostatService.setCharacteristic(
      this.platform.Characteristic.Name,
      system.name || `Lennox Thermostat ${system.extId.substring(0, 8)}`,
    );

    // Register handlers for required characteristics
    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Register handlers for optional characteristics
    this.thermostatService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .onSet(this.setCoolingThresholdTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .onSet(this.setHeatingThresholdTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Check if fan service should be added
    const zoneData = this.platform.getPrimaryZoneData(system);
    if (zoneData && zoneData.userData.fanMode) {
      this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
        || this.accessory.addService(this.platform.Service.Fanv2);

      this.fanService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${system.name || 'Lennox'} Fan`,
      );

      this.fanService.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(this.getFanActive.bind(this))
        .onSet(this.setFanActive.bind(this));

      this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .onGet(this.getFanRotationSpeed.bind(this))
        .onSet(this.setFanRotationSpeed.bind(this));
    }

    // Note: Handler reference is stored in platform.accessoryHandlers Map
    // (not in context to avoid circular references when saving to disk)

    // Update initial status (fire and forget - polling will handle regular updates)
    this.updateStatus(system).catch(error => {
      this.platform.log.warn(`Failed to update initial status for ${system.extId}:`, error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Update status from system data
   */
  async updateStatus(system: LennoxSystem): Promise<void> {
    try {
      const zoneData = this.platform.getPrimaryZoneData(system);
      if (!zoneData) {
        this.platform.log.warn(`No zone data found for system ${system.extId}`);
        return;
      }

    const userData = zoneData.userData;

    // Extract startTime from ssp (setpoint schedule period) if available
    // ssp appears to be in seconds from midnight for the current schedule period
    if (userData.ssp !== undefined && userData.ssp > 0) {
      this.currentStartTime = userData.ssp;
      this.platform.log.debug(`[STATUS] Discovered startTime from ssp: ${this.currentStartTime}`);
    }

    // Note: scheduleId is not directly available in userData
    // It would need to come from retrieved zone messages, but we'll infer it based on mode
    // For now, we'll calculate it dynamically when needed based on zone mode

    // Update temperature (convert to Celsius if needed)
    const isFahrenheit = userData.dispUnits === 'F';
    this.currentTemperature = isFahrenheit
      ? this.fahrenheitToCelsius(parseFloat(userData.zit) || 0)
      : parseFloat(userData.zitC) || 0;

    // Update setpoints
    this.heatingThresholdTemperature = isFahrenheit
      ? this.fahrenheitToCelsius(parseFloat(userData.hsp) || 0)
      : parseFloat(userData.hspC) || 0;

    this.coolingThresholdTemperature = isFahrenheit
      ? this.fahrenheitToCelsius(parseFloat(userData.csp) || 0)
      : parseFloat(userData.cspC) || 0;

    // Update target temperature based on mode
    this.updateTargetTemperatureFromMode(userData);

    // Update heating/cooling states
    this.targetHeatingCoolingState = this.mapOpModeToState(userData.opMode);
    this.currentHeatingCoolingState = this.mapStatusToState(userData.status);

    // Update humidity
    this.currentRelativeHumidity = parseFloat(userData.rh) || 0;

    // Update display units
    this.temperatureDisplayUnits = isFahrenheit ? 1 : 0;

    // Update fan if available
    if (userData.fanMode && this.fanService) {
      this.fanActive = userData.status !== 'off';
      this.fanRotationSpeed = userData.fanMode === 'on' ? 100 : (userData.fanMode === 'auto' ? 50 : 0);
    }

    // Update characteristics
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.currentTemperature,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      this.targetTemperature,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.targetHeatingCoolingState,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.currentHeatingCoolingState,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature,
      this.coolingThresholdTemperature,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.HeatingThresholdTemperature,
      this.heatingThresholdTemperature,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      this.currentRelativeHumidity,
    );
    this.thermostatService.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.temperatureDisplayUnits,
    );

    if (this.fanService) {
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.fanActive ? 1 : 0,
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.fanRotationSpeed,
      );
    }
    } catch (error) {
      this.platform.log.error(`Error updating status for system ${system.extId}:`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  // Getter methods
  getCurrentTemperature(): CharacteristicValue {
    return this.currentTemperature;
  }

  getTargetTemperature(): CharacteristicValue {
    return this.targetTemperature;
  }

  getTargetHeatingCoolingState(): CharacteristicValue {
    return this.targetHeatingCoolingState;
  }

  getCurrentHeatingCoolingState(): CharacteristicValue {
    return this.currentHeatingCoolingState;
  }

  getCoolingThresholdTemperature(): CharacteristicValue {
    return this.coolingThresholdTemperature;
  }

  getHeatingThresholdTemperature(): CharacteristicValue {
    return this.heatingThresholdTemperature;
  }

  getCurrentRelativeHumidity(): CharacteristicValue {
    return this.currentRelativeHumidity;
  }

  getTemperatureDisplayUnits(): CharacteristicValue {
    return this.temperatureDisplayUnits;
  }

  getFanActive(): CharacteristicValue {
    return this.fanActive ? 1 : 0;
  }

  getFanRotationSpeed(): CharacteristicValue {
    return this.fanRotationSpeed;
  }

  // Setter methods
  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    try {
      this.targetTemperature = value as number;
      this.platform.log.info(`[CONTROL] HomeKit requested setTargetTemperature: ${this.targetTemperature}°C`);

      // Refresh system data to ensure we have the latest state
      // This ensures we're working with current setpoints and mode
      let currentSystem = this.system;
      try {
        const plantToken = await this.platform.authManager.getPlantToken();
        const systems = await this.platform.client.getSystems(plantToken);
        const updatedSystem = systems.find(s => s.extId === this.systemId);
        if (updatedSystem) {
          currentSystem = updatedSystem;
          this.platform.log.debug(`[CONTROL] Refreshed system data before update`);
        }
      } catch (error) {
        this.platform.log.warn(`[CONTROL] Could not refresh system data, using cached:`, error instanceof Error ? error.message : String(error));
      }

      const zoneData = this.platform.getPrimaryZoneData(currentSystem);
      if (!zoneData) {
        this.platform.log.error('[CONTROL] No zone data available');
        return;
      }

    const userData = zoneData.userData;
    const isFahrenheit = userData.dispUnits === 'F';
    const targetTemp = isFahrenheit ? this.celsiusToFahrenheit(this.targetTemperature) : this.targetTemperature;

      // Determine which setpoint to update based on current mode
      const systemMode = this.mapOpModeToSystemMode(userData.opMode);
      if (this.targetHeatingCoolingState === 1) {
        // Heat mode - update heating setpoint
        await this.updateSetpoints(targetTemp, userData.csp, systemMode, userData.fanMode, currentSystem);
      } else if (this.targetHeatingCoolingState === 2) {
        // Cool mode - update cooling setpoint
        await this.updateSetpoints(userData.hsp, targetTemp, systemMode, userData.fanMode, currentSystem);
      } else if (this.targetHeatingCoolingState === 3) {
        // Auto mode - update both setpoints (maintain a reasonable gap)
        const gap = isFahrenheit ? 3 : 1.5; // 3°F or 1.5°C gap
        await this.updateSetpoints(
          targetTemp - gap,
          targetTemp + gap,
          systemMode,
          userData.fanMode,
          currentSystem,
        );
      }
    } catch (error) {
      this.platform.log.error('Error setting target temperature:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    try {
      this.targetHeatingCoolingState = value as number;
      this.platform.log.debug(`Set Target Heating Cooling State: ${this.targetHeatingCoolingState}`);

      const zoneData = this.platform.getPrimaryZoneData(this.system);
      if (!zoneData) {
        this.platform.log.error('No zone data available');
        return;
      }

    const userData = zoneData.userData;

    let systemMode: 'heat and cool' | 'heat' | 'cool' | 'off';
    switch (this.targetHeatingCoolingState) {
      case 0: // Off
        systemMode = 'off';
        break;
      case 1: // Heat
        systemMode = 'heat';
        break;
      case 2: // Cool
        systemMode = 'cool';
        break;
      case 3: // Auto
        systemMode = 'heat and cool';
        break;
      default:
        systemMode = 'off';
    }

    await this.updateSetpoints(
      userData.hsp,
      userData.csp,
      systemMode,
      userData.fanMode,
    );
    } catch (error) {
      this.platform.log.error('Error setting target heating cooling state:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    try {
      this.coolingThresholdTemperature = value as number;
      this.platform.log.debug(`Set Cooling Threshold Temperature: ${this.coolingThresholdTemperature}°C`);

      const zoneData = this.platform.getPrimaryZoneData(this.system);
      if (!zoneData) {
        this.platform.log.error('No zone data available');
        return;
      }

    const userData = zoneData.userData;
    const isFahrenheit = userData.dispUnits === 'F';
    const csp = isFahrenheit ? this.celsiusToFahrenheit(this.coolingThresholdTemperature) : this.coolingThresholdTemperature;

    const systemMode = this.mapOpModeToSystemMode(userData.opMode);
    await this.updateSetpoints(
      userData.hsp,
      csp.toString(),
      systemMode,
      userData.fanMode,
    );
    } catch (error) {
      this.platform.log.error('Error setting cooling threshold temperature:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    try {
      this.heatingThresholdTemperature = value as number;
      this.platform.log.debug(`Set Heating Threshold Temperature: ${this.heatingThresholdTemperature}°C`);

      const zoneData = this.platform.getPrimaryZoneData(this.system);
      if (!zoneData) {
        this.platform.log.error('No zone data available');
        return;
      }

    const userData = zoneData.userData;
    const isFahrenheit = userData.dispUnits === 'F';
    const hsp = isFahrenheit ? this.celsiusToFahrenheit(this.heatingThresholdTemperature) : this.heatingThresholdTemperature;

    const systemMode = this.mapOpModeToSystemMode(userData.opMode);
    await this.updateSetpoints(
      hsp.toString(),
      userData.csp,
      systemMode,
      userData.fanMode,
    );
    } catch (error) {
      this.platform.log.error('Error setting heating threshold temperature:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    this.temperatureDisplayUnits = value as number;
    this.platform.log.debug(`Set Temperature Display Units: ${this.temperatureDisplayUnits}`);
  }

  async setFanActive(value: CharacteristicValue): Promise<void> {
    try {
      this.fanActive = (value as number) === 1;
      this.platform.log.debug(`Set Fan Active: ${this.fanActive}`);

      if (this.fanService) {
        // Update fan mode based on active state
        const fanMode = this.fanActive ? 'on' : 'auto';
        await this.updateFanMode(fanMode);
      }
    } catch (error) {
      this.platform.log.error('Error setting fan active:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async setFanRotationSpeed(value: CharacteristicValue): Promise<void> {
    try {
      this.fanRotationSpeed = value as number;
      this.platform.log.debug(`Set Fan Rotation Speed: ${this.fanRotationSpeed}%`);

      if (this.fanService) {
        // Map rotation speed to fan mode
        let fanMode: 'auto' | 'on' | 'circulate' = 'auto';
        if (this.fanRotationSpeed > 75) {
          fanMode = 'on';
        } else if (this.fanRotationSpeed > 25) {
          fanMode = 'circulate';
        }

        await this.updateFanMode(fanMode);
      }
    } catch (error) {
      this.platform.log.error('Error setting fan rotation speed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Calculate schedule ID for manual mode (16 + zone.id)
   */
  private getManualModeScheduleId(zoneId: number): number {
    return 16 + zoneId;
  }

  /**
   * Calculate schedule ID for override mode (32 + zone.id)
   */
  private getOverrideScheduleId(zoneId: number): number {
    return 32 + zoneId;
  }

  /**
   * Check if zone is in manual mode
   * Zone is in manual mode if currentScheduleId === 16 + zone.id
   */
  private isZoneManualMode(zoneId: number, currentScheduleId: number | null): boolean {
    if (currentScheduleId === null) {
      return false; // Can't determine without schedule ID
    }
    return currentScheduleId === this.getManualModeScheduleId(zoneId);
  }

  /**
   * Check if zone is in override mode
   * Zone is in override mode if currentScheduleId === 32 + zone.id
   */
  private isZoneOverride(zoneId: number, currentScheduleId: number | null): boolean {
    if (currentScheduleId === null) {
      return false; // Can't determine without schedule ID
    }
    return currentScheduleId === this.getOverrideScheduleId(zoneId);
  }

  /**
   * Update setpoints via API
   */
  private async updateSetpoints(
    hsp: string | number,
    csp: string | number,
    systemMode: 'heat and cool' | 'heat' | 'cool' | 'off',
    fanMode?: 'auto' | 'on' | 'circulate',
    system?: LennoxSystem, // Optional system parameter to use fresh data
  ): Promise<void> {
    // Prevent concurrent updates - if one is in progress, wait for it to complete
    if (this.updateInProgress) {
      this.platform.log.warn(`[CONTROL] Update already in progress, waiting...`);
      // Wait up to 5 seconds for the previous update to complete
      for (let i = 0; i < 50 && this.updateInProgress; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.updateInProgress) {
        this.platform.log.error(`[CONTROL] Previous update still in progress, skipping this update`);
        return;
      }
    }
    
    this.updateInProgress = true;
    this.platform.log.info(`[CONTROL] Starting setpoint update: hsp=${hsp}, csp=${csp}, mode=${systemMode}, fanMode=${fanMode || 'auto'}`);
    
    try {
      // Use provided system or fall back to cached system
      const systemToUse = system || this.system;
      const zoneData = this.platform.getPrimaryZoneData(systemToUse);
      if (!zoneData) {
        this.platform.log.error('[CONTROL] No zone data available - cannot update setpoints');
        throw new Error('No zone data available');
      }

      const userData = zoneData.userData;
      const isFahrenheit = userData.dispUnits === 'F';
      
      // Zone ID should be 0 for primary zone (as shown in MITM capture)
      // userData.id is a UUID/identifier, not a zone ID
      // For single-zone systems, zone ID is always 0
      // For multi-zone systems, we'd need to determine the zone from substatus index
      const zoneId = 0; // Primary zone - matches MITM capture
      
      // Determine zone mode and calculate appropriate schedule ID
      // Since we don't have scheduleId in userData, we'll assume zone is following a schedule
      // and use override mode (32 + zone.id) which requires both schedule and hold commands
      // If we had scheduleId, we could check: manual (16+id), override (32+id), or following schedule
      const isManualMode = this.isZoneManualMode(zoneId, this.currentZoneScheduleId);
      const isOverrideMode = this.isZoneOverride(zoneId, this.currentZoneScheduleId);
      
      // Calculate schedule ID based on mode
      let targetScheduleId: number;
      let needsHold = false;
      
      if (isManualMode) {
        targetScheduleId = this.getManualModeScheduleId(zoneId);
        needsHold = false; // Manual mode doesn't need hold
        this.platform.log.info(`[CONTROL] Zone is in manual mode, using schedule ID ${targetScheduleId}`);
      } else if (isOverrideMode) {
        targetScheduleId = this.getOverrideScheduleId(zoneId);
        needsHold = false; // Already in override, just update schedule
        this.platform.log.info(`[CONTROL] Zone is in override mode, using schedule ID ${targetScheduleId}`);
      } else {
        // Zone is following a schedule, need to create override
        targetScheduleId = this.getOverrideScheduleId(zoneId);
        needsHold = true; // Need to set hold to activate override
        this.platform.log.info(`[CONTROL] Zone is following schedule, creating override with schedule ID ${targetScheduleId}`);
      }

      // Convert to appropriate units
      const hspValue = typeof hsp === 'number' ? hsp : parseFloat(hsp);
      const cspValue = typeof csp === 'number' ? csp : parseFloat(csp);

      const hspF = isFahrenheit ? hspValue : this.celsiusToFahrenheit(hspValue);
      const cspF = isFahrenheit ? cspValue : this.celsiusToFahrenheit(cspValue);
      const hspC = isFahrenheit ? this.fahrenheitToCelsius(hspValue) : hspValue;
      const cspC = isFahrenheit ? this.fahrenheitToCelsius(cspValue) : cspValue;

      // Calculate setpoint (sp/spC) - average of heating and cooling setpoints for auto mode
      // For single mode, use the appropriate setpoint
      // Note: sp should be integer (rounded), spC should be float with 1 decimal
      const spF = systemMode === 'heat and cool' ? Math.round((hspF + cspF) / 2) : (systemMode === 'heat' ? Math.round(hspF) : Math.round(cspF));
      const spC = systemMode === 'heat and cool' ? parseFloat(((hspC + cspC) / 2).toFixed(1)) : (systemMode === 'heat' ? parseFloat(hspC.toFixed(1)) : parseFloat(cspC.toFixed(1)));

      // Preserve current zone values when creating override (matching lennoxs30api behavior)
      // For setpoints, we use the new values being set
      // For other values, preserve from current zone or use defaults
      
      // Preserve humidity settings - defaults if not available in userData
      // These values would ideally come from the current schedule period
      const husp = 40; // Default humidity setpoint
      const desp = 55; // Default dehumidification setpoint
      const humidityMode = 'off'; // Default humidity mode (could be 'humidify' if system supports it)

      // Use discovered startTime from zone or fallback
      // startTime should come from zone's current period (ssp field)
      const startTime = this.currentStartTime || 25200; // Default to 7:00 AM (25200 seconds) if not discovered
      
      this.platform.log.debug(`[CONTROL] Zone ID: ${zoneId}, Schedule ID: ${targetScheduleId}, StartTime: ${startTime}, NeedsHold: ${needsHold}`);

      // Step 1: Update schedule with new setpoints
      // Include all fields from MITM capture in the exact order to match app behavior
      // Field order from MITM: desp, hsp, cspC, sp, husp, humidityMode, systemMode, spC, hspC, csp, startTime, fanMode
      const scheduleCommand: ScheduleCommand = {
        schedules: [
          {
            schedule: {
              periods: [
                {
                  id: 0,
                  period: {
                    desp, // Dehumidification setpoint
                    hsp: Math.round(hspF), // Heating setpoint (Fahrenheit, integer)
                    cspC: parseFloat(cspC.toFixed(1)), // Cooling setpoint (Celsius, 1 decimal)
                    sp: Math.round(spF), // Setpoint (Fahrenheit, integer - matches MITM)
                    husp, // Humidity setpoint
                    humidityMode, // Humidity mode
                    systemMode, // System mode
                    spC: spC, // Setpoint (Celsius, 1 decimal)
                    hspC: parseFloat(hspC.toFixed(1)), // Heating setpoint (Celsius, 1 decimal)
                    csp: Math.round(cspF), // Cooling setpoint (Fahrenheit, integer)
                    startTime, // Schedule period start time
                    fanMode: fanMode || userData.fanMode || 'auto', // Fan mode
                  },
                },
              ],
            },
            id: targetScheduleId,
          },
        ],
      };

      const scheduleMessage: PublishMessage = {
        MessageType: 'Command',
        SenderID: this.senderId,
        MessageID: uuidv4(),
        TargetID: this.systemId,
        Data: scheduleCommand,
      };

      this.platform.log.info(`[CONTROL] Publishing schedule command to schedule ID ${targetScheduleId}`);
      this.platform.log.debug(`[CONTROL] Schedule command payload: ${JSON.stringify(scheduleMessage, null, 2)}`);
      
      let scheduleResponse;
      try {
        scheduleResponse = await this.platform.client.publishCommand(scheduleMessage);
        this.platform.log.info(`[CONTROL] Schedule command response: code=${scheduleResponse.code}, message="${scheduleResponse.message || ''}", retry_after=${scheduleResponse.retry_after || 0}`);
        this.platform.log.debug(`[CONTROL] Full schedule response: ${JSON.stringify(scheduleResponse, null, 2)}`);
      } catch (error) {
        this.platform.log.error(`[CONTROL] Schedule command failed with exception:`, error instanceof Error ? error.message : String(error));
        throw error;
      }

      // Validate schedule command response
      if (scheduleResponse.code !== 1) {
        const errorMsg = `Schedule command failed with code ${scheduleResponse.code}: ${scheduleResponse.message || 'Unknown error'}`;
        this.platform.log.error(`[CONTROL] ${errorMsg}`);
        throw new Error(errorMsg);
      }
      
      this.platform.log.info(`[CONTROL] Schedule command succeeded`);

      // Step 2: Apply schedule hold (only if zone is following a schedule)
      if (needsHold) {
        // Wait a brief moment between commands to ensure schedule update is processed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Hold command structure from lennoxs30api: expiresOn="0", expirationMode="nextPeriod"
        const zoneHoldCommand: ZoneHoldCommand = {
          zones: [
            {
              config: {
                scheduleHold: {
                  scheduleId: targetScheduleId,
                  exceptionType: 'hold',
                  enabled: true,
                  expiresOn: '0', // String "0" - expires on next period (matches lennoxs30api)
                  expirationMode: 'nextPeriod', // Matches lennoxs30api
                },
              },
              id: zoneId,
            },
          ],
        };

        const holdMessage: PublishMessage = {
          MessageType: 'Command',
          SenderID: this.senderId,
          MessageID: uuidv4(),
          TargetID: this.systemId,
          Data: zoneHoldCommand,
        };

        this.platform.log.info(`[CONTROL] Publishing zone hold command for zone ${zoneId}, schedule ${targetScheduleId}`);
        this.platform.log.debug(`[CONTROL] Zone hold command payload: ${JSON.stringify(holdMessage, null, 2)}`);
        
        let holdResponse;
        try {
          holdResponse = await this.platform.client.publishCommand(holdMessage);
          this.platform.log.info(`[CONTROL] Zone hold command response: code=${holdResponse.code}, message="${holdResponse.message || ''}", retry_after=${holdResponse.retry_after || 0}`);
          this.platform.log.debug(`[CONTROL] Full zone hold response: ${JSON.stringify(holdResponse, null, 2)}`);
        } catch (error) {
          this.platform.log.error(`[CONTROL] Zone hold command failed with exception:`, error instanceof Error ? error.message : String(error));
          throw error;
        }

        // Validate zone hold command response
        if (holdResponse.code !== 1) {
          const errorMsg = `Zone hold command failed with code ${holdResponse.code}: ${holdResponse.message || 'Unknown error'}`;
          this.platform.log.error(`[CONTROL] ${errorMsg}`);
          throw new Error(errorMsg);
        }
        
        this.platform.log.info(`[CONTROL] Zone hold command succeeded`);
      } else {
        this.platform.log.info(`[CONTROL] Zone is in manual/override mode, hold command not needed`);
      }
      this.platform.log.info(`[CONTROL] Successfully updated setpoints: Heat ${hspF}°F/${hspC}°C, Cool ${cspF}°F/${cspC}°C, Mode: ${systemMode}`);
      
      // Wait a moment for the system to process the commands
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Note: The thermostat should update within a few seconds
      // If it doesn't, check the logs for any errors or verify:
      // 1. Zone ID is correct (should be 0 for primary zone)
      // 2. Schedule ID matches an existing schedule (32 is default)
      // 3. StartTime matches current schedule period (507600 is default)
      // 4. All command fields match the MITM capture structure
    } catch (error) {
      this.platform.log.error(`[CONTROL] Error updating setpoints:`, error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        this.platform.log.debug(`[CONTROL] Error stack trace: ${error.stack}`);
      }
      throw error;
    } finally {
      this.updateInProgress = false;
    }
  }

  /**
   * Update fan mode
   */
  private async updateFanMode(fanMode: 'auto' | 'on' | 'circulate'): Promise<void> {
    const zoneData = this.platform.getPrimaryZoneData(this.system);
    if (!zoneData) {
      throw new Error('No zone data available');
    }

    const userData = zoneData.userData;
    const systemMode = this.mapOpModeToSystemMode(userData.opMode);
    await this.updateSetpoints(userData.hsp, userData.csp, systemMode, fanMode);
  }

  /**
   * Update target temperature based on current mode
   */
  private updateTargetTemperatureFromMode(userData: UserData): void {
    const isFahrenheit = userData.dispUnits === 'F';

    switch (this.targetHeatingCoolingState) {
      case 1: // Heat
        this.targetTemperature = isFahrenheit
          ? this.fahrenheitToCelsius(parseFloat(userData.hsp) || 0)
          : parseFloat(userData.hspC) || 0;
        break;
      case 2: // Cool
        this.targetTemperature = isFahrenheit
          ? this.fahrenheitToCelsius(parseFloat(userData.csp) || 0)
          : parseFloat(userData.cspC) || 0;
        break;
      case 3: { // Auto - use average of setpoints
        const hsp = isFahrenheit
          ? this.fahrenheitToCelsius(parseFloat(userData.hsp) || 0)
          : parseFloat(userData.hspC) || 0;
        const csp = isFahrenheit
          ? this.fahrenheitToCelsius(parseFloat(userData.csp) || 0)
          : parseFloat(userData.cspC) || 0;
        this.targetTemperature = (hsp + csp) / 2;
        break;
      }
      default:
        this.targetTemperature = this.currentTemperature;
    }
  }

  /**
   * Map opMode to system mode for API calls
   */
  private mapOpModeToSystemMode(opMode: 'hc' | 'heat' | 'cool' | 'off'): 'heat and cool' | 'heat' | 'cool' | 'off' {
    switch (opMode) {
      case 'hc':
        return 'heat and cool';
      case 'heat':
        return 'heat';
      case 'cool':
        return 'cool';
      case 'off':
        return 'off';
      default:
        return 'off';
    }
  }

  /**
   * Map opMode to HomeKit state
   */
  private mapOpModeToState(opMode: string): number {
    switch (opMode) {
      case 'hc':
        return 3; // Auto
      case 'heat':
        return 1; // Heat
      case 'cool':
        return 2; // Cool
      case 'off':
        return 0; // Off
      default:
        return 0;
    }
  }

  /**
   * Map status to HomeKit current state
   */
  private mapStatusToState(status: string): number {
    switch (status) {
      case 'h':
        return 1; // Heating
      case 'c':
        return 2; // Cooling
      case 'off':
        return 0; // Off
      default:
        return 0;
    }
  }

  /**
   * Temperature conversion helpers
   */
  private fahrenheitToCelsius(f: number): number {
    return (f - 32) * 5 / 9;
  }

  private celsiusToFahrenheit(c: number): number {
    return (c * 9 / 5) + 32;
  }
}

