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
  private scheduleId: number = 32; // Default schedule ID, will be discovered from system data
  private currentStartTime: number = 507600; // Default start time (matches MITM capture), will be discovered from system data

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

    // Discover schedule ID and start time from system data
    // The schedule ID appears to be 32 based on MITM captures, but we'll try to discover it
    // For now, we'll use 32 as default and try to extract start time from ssp (setpoint schedule period)
    // The startTime appears to be in seconds from midnight for the current schedule period
    // We'll use a reasonable default and update if we can discover it from the system
    if (userData.ssp !== undefined) {
      // ssp might contain schedule period information, but we'll keep default for now
      // The actual schedule discovery would require parsing schedule messages from the API
    }

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
      this.platform.log.debug(`Set Target Temperature: ${this.targetTemperature}°C`);

      const zoneData = this.platform.getPrimaryZoneData(this.system);
      if (!zoneData) {
        this.platform.log.error('No zone data available');
        return;
      }

    const userData = zoneData.userData;
    const isFahrenheit = userData.dispUnits === 'F';
    const targetTemp = isFahrenheit ? this.celsiusToFahrenheit(this.targetTemperature) : this.targetTemperature;

      // Determine which setpoint to update based on current mode
      const systemMode = this.mapOpModeToSystemMode(userData.opMode);
      if (this.targetHeatingCoolingState === 1) {
        // Heat mode - update heating setpoint
        await this.updateSetpoints(targetTemp, userData.csp, systemMode, userData.fanMode);
      } else if (this.targetHeatingCoolingState === 2) {
        // Cool mode - update cooling setpoint
        await this.updateSetpoints(userData.hsp, targetTemp, systemMode, userData.fanMode);
      } else if (this.targetHeatingCoolingState === 3) {
        // Auto mode - update both setpoints (maintain a reasonable gap)
        const gap = isFahrenheit ? 3 : 1.5; // 3°F or 1.5°C gap
        await this.updateSetpoints(
          targetTemp - gap,
          targetTemp + gap,
          systemMode,
          userData.fanMode,
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
   * Update setpoints via API
   */
  private async updateSetpoints(
    hsp: string | number,
    csp: string | number,
    systemMode: 'heat and cool' | 'heat' | 'cool' | 'off',
    fanMode?: 'auto' | 'on' | 'circulate',
  ): Promise<void> {
    try {
      const zoneData = this.platform.getPrimaryZoneData(this.system);
      if (!zoneData) {
        throw new Error('No zone data available');
      }

      const userData = zoneData.userData;
      const isFahrenheit = userData.dispUnits === 'F';

      // Convert to appropriate units
      const hspValue = typeof hsp === 'number' ? hsp : parseFloat(hsp);
      const cspValue = typeof csp === 'number' ? csp : parseFloat(csp);

      const hspF = isFahrenheit ? hspValue : this.celsiusToFahrenheit(hspValue);
      const cspF = isFahrenheit ? cspValue : this.celsiusToFahrenheit(cspValue);
      const hspC = isFahrenheit ? this.fahrenheitToCelsius(hspValue) : hspValue;
      const cspC = isFahrenheit ? this.fahrenheitToCelsius(cspValue) : cspValue;

      // Calculate setpoint (sp/spC) - average of heating and cooling setpoints for auto mode
      // For single mode, use the appropriate setpoint
      const spF = systemMode === 'heat and cool' ? Math.round((hspF + cspF) / 2) : (systemMode === 'heat' ? Math.round(hspF) : Math.round(cspF));
      const spC = systemMode === 'heat and cool' ? parseFloat(((hspC + cspC) / 2).toFixed(1)) : (systemMode === 'heat' ? parseFloat(hspC.toFixed(1)) : parseFloat(cspC.toFixed(1)));

      // Extract humidity settings from userData if available
      // Based on MITM capture, these values are typically:
      // husp: 30-40 (humidity setpoint)
      // desp: 55 (dehumidification setpoint)
      // humidityMode: "off" or "humidify"
      const husp = 40; // Default humidity setpoint
      const desp = 55; // Default dehumidification setpoint
      const humidityMode = 'off'; // Default to off, could be "humidify" if system supports it

      // Use discovered start time or default
      // Based on MITM capture, startTime 507600 was used, which appears to be a schedule period time
      // We'll use the stored currentStartTime or default to 507600 (matches MITM capture)
      const startTime = this.currentStartTime || 507600;

      // Step 1: Update schedule with new setpoints
      // Include all fields from MITM capture to match app behavior
      const scheduleCommand: ScheduleCommand = {
        schedules: [
          {
            schedule: {
              periods: [
                {
                  id: 0,
                  period: {
                    desp,
                    hsp: Math.round(hspF),
                    hspC: parseFloat(hspC.toFixed(1)),
                    csp: Math.round(cspF),
                    cspC: parseFloat(cspC.toFixed(1)),
                    sp: spF,
                    spC: spC,
                    husp,
                    humidityMode,
                    systemMode,
                    startTime,
                    fanMode: fanMode || userData.fanMode || 'auto',
                  },
                },
              ],
            },
            id: this.scheduleId,
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

      this.platform.log.debug(`Publishing schedule command: ${JSON.stringify(scheduleMessage, null, 2)}`);
      const scheduleResponse = await this.platform.client.publishCommand(scheduleMessage);
      this.platform.log.debug(`Schedule command response: ${JSON.stringify(scheduleResponse, null, 2)}`);

      // Validate schedule command response
      if (scheduleResponse.code !== 1) {
        throw new Error(`Schedule command failed with code ${scheduleResponse.code}: ${scheduleResponse.message || 'Unknown error'}`);
      }

      // Step 2: Apply schedule hold
      const expiresOn = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 hours from now

      const zoneHoldCommand: ZoneHoldCommand = {
        zones: [
          {
            config: {
              scheduleHold: {
                scheduleId: this.scheduleId,
                exceptionType: 'hold',
                enabled: true,
                expiresOn: expiresOn.toString(),
                expirationMode: 'timed',
              },
            },
            id: 0, // Primary zone
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

      this.platform.log.debug(`Publishing zone hold command: ${JSON.stringify(holdMessage, null, 2)}`);
      const holdResponse = await this.platform.client.publishCommand(holdMessage);
      this.platform.log.debug(`Zone hold command response: ${JSON.stringify(holdResponse, null, 2)}`);

      // Validate zone hold command response
      if (holdResponse.code !== 1) {
        throw new Error(`Zone hold command failed with code ${holdResponse.code}: ${holdResponse.message || 'Unknown error'}`);
      }

      this.platform.log.info(`Successfully updated setpoints: Heat ${hspF}°F/${hspC}°C, Cool ${cspF}°F/${cspC}°C, Mode: ${systemMode}`);
    } catch (error) {
      this.platform.log.error('Error updating setpoints:', error instanceof Error ? error.message : String(error));
      throw error;
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

