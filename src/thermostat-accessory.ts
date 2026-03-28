import { PlatformAccessory, Service, Characteristic, CharacteristicValue } from "homebridge";
import { SymphonyPlatform } from "./platform.js";
import { SymphonyClient, MODE, MODE_OF_OPERATION, ZoneData } from "./symphony-client.js";

const WRITE_DEBOUNCE_MS = 500;

export class ThermostatAccessory {
  private service: Service;
  private humidityService: Service;
  private writeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private readonly Characteristic: typeof Characteristic;

  constructor(
    private readonly platform: SymphonyPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: SymphonyClient,
    private readonly zone: number,
  ) {
    this.Characteristic = platform.Characteristic;

    // Accessory info
    this.accessory
      .getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, "WaterFurnace")
      .setCharacteristic(platform.Characteristic.Model, "Symphony IZ2")
      .setCharacteristic(platform.Characteristic.SerialNumber, `${client.gatewayId}-Z${zone}`);

    // Thermostat service
    this.service =
      this.accessory.getService(platform.Service.Thermostat) ||
      this.accessory.addService(platform.Service.Thermostat);

    this.service.setCharacteristic(platform.Characteristic.Name, accessory.displayName);

    // Temperature display units (Fahrenheit)
    this.service.setCharacteristic(
      platform.Characteristic.TemperatureDisplayUnits,
      platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    );

    // Current temperature (read-only)
    this.service
      .getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(() => this.getCurrentTemp());

    // Target temperature (read/write)
    this.service
      .getCharacteristic(platform.Characteristic.TargetTemperature)
      .setProps({ minValue: 7, maxValue: 35, minStep: 0.5 })
      .onGet(() => this.getTargetTemp())
      .onSet((value) => this.setTargetTemp(value));

    // Current heating/cooling state (read-only)
    this.service
      .getCharacteristic(platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.getCurrentState());

    // Target heating/cooling state (read/write)
    this.service
      .getCharacteristic(platform.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.getTargetState())
      .onSet((value) => this.setTargetState(value));

    // Cooling threshold (for Auto mode)
    this.service
      .getCharacteristic(platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 7, maxValue: 35, minStep: 0.5 })
      .onGet(() => this.getCoolingThreshold())
      .onSet((value) => this.setCoolingThreshold(value));

    // Heating threshold (for Auto mode)
    this.service
      .getCharacteristic(platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 4, maxValue: 35, minStep: 0.5 })
      .onGet(() => this.getHeatingThreshold())
      .onSet((value) => this.setHeatingThreshold(value));

    // Humidity sensor
    this.humidityService =
      this.accessory.getService(platform.Service.HumiditySensor) ||
      this.accessory.addService(platform.Service.HumiditySensor);

    this.humidityService
      .getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.getHumidity());
  }

  updateFromData(): void {
    const data = this.getZoneData();
    if (!data) return;

    this.platform.log.debug(
      `Zone ${this.zone}: Current temp ${data.currentTemp}°F (${this.fToC(data.currentTemp)}°C), ` +
      `heat setpoint ${data.heatingSetpoint}°F, cool setpoint ${data.coolingSetpoint}°F, ` +
      `humidity ${data.humidity}%, mode ${data.activeMode}`,
    );

    this.service.updateCharacteristic(
      this.Characteristic.CurrentTemperature,
      this.fToC(data.currentTemp),
    );
    this.service.updateCharacteristic(
      this.Characteristic.TargetTemperature,
      this.getTargetTempValue(data),
    );
    this.service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      this.mapCurrentState(),
    );
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.mapTargetState(data.activeMode),
    );
    this.service.updateCharacteristic(
      this.Characteristic.CoolingThresholdTemperature,
      this.fToC(data.coolingSetpoint),
    );
    this.service.updateCharacteristic(
      this.Characteristic.HeatingThresholdTemperature,
      this.fToC(data.heatingSetpoint),
    );
    this.humidityService.updateCharacteristic(
      this.Characteristic.CurrentRelativeHumidity,
      data.humidity,
    );
  }

  private getZoneData(): ZoneData | undefined {
    return this.client.currentData.zones.get(this.zone);
  }

  // -- Getters --

  private getCurrentTemp(): CharacteristicValue {
    const data = this.getZoneData();
    const tempC = data ? this.fToC(data.currentTemp) : 20;
    this.platform.log.debug(`Zone ${this.zone}: HomeKit requested current temp → ${data?.currentTemp ?? "N/A"}°F (${tempC}°C)`);
    return tempC;
  }

  private getTargetTemp(): CharacteristicValue {
    const data = this.getZoneData();
    if (!data) return 21;
    return this.getTargetTempValue(data);
  }

  private getTargetTempValue(data: ZoneData): number {
    // In Auto mode, use the midpoint; in Heat/Cool use the respective setpoint
    if (data.activeMode === MODE.COOL) {
      return this.fToC(data.coolingSetpoint);
    } else if (data.activeMode === MODE.HEAT || data.activeMode === MODE.EHEAT) {
      return this.fToC(data.heatingSetpoint);
    }
    // Auto or Off - use midpoint
    return this.fToC((data.heatingSetpoint + data.coolingSetpoint) / 2);
  }

  private getCurrentState(): CharacteristicValue {
    return this.mapCurrentState();
  }

  private getTargetState(): CharacteristicValue {
    const data = this.getZoneData();
    if (!data) return this.Characteristic.TargetHeatingCoolingState.OFF;
    return this.mapTargetState(data.activeMode);
  }

  private getCoolingThreshold(): CharacteristicValue {
    const data = this.getZoneData();
    return data ? this.fToC(data.coolingSetpoint) : 25;
  }

  private getHeatingThreshold(): CharacteristicValue {
    const data = this.getZoneData();
    return data ? this.fToC(data.heatingSetpoint) : 20;
  }

  private getHumidity(): CharacteristicValue {
    const data = this.getZoneData();
    return data ? data.humidity : 50;
  }

  // -- Setters --

  private setTargetTemp(value: CharacteristicValue): void {
    const data = this.getZoneData();
    if (!data) return;

    const tempF = this.cToF(value as number);
    const rounded = Math.round(tempF);

    // Determine which setpoint would be written and check if it already matches
    if (data.activeMode === MODE.COOL) {
      if (rounded === Math.round(data.coolingSetpoint)) return;
    } else if (data.activeMode === MODE.HEAT || data.activeMode === MODE.EHEAT) {
      if (rounded === Math.round(data.heatingSetpoint)) return;
    } else {
      const midpoint = (data.heatingSetpoint + data.coolingSetpoint) / 2;
      if (tempF >= midpoint) {
        if (rounded === Math.round(data.coolingSetpoint)) return;
      } else {
        if (rounded === Math.round(data.heatingSetpoint)) return;
      }
    }

    this.debouncedWrite(`z${this.zone}-target`, () => {
      if (data.activeMode === MODE.COOL) {
        this.client.setCoolingSetpoint(this.zone, tempF);
      } else if (data.activeMode === MODE.HEAT || data.activeMode === MODE.EHEAT) {
        this.client.setHeatingSetpoint(this.zone, tempF);
      } else {
        const midpoint = (data.heatingSetpoint + data.coolingSetpoint) / 2;
        if (tempF >= midpoint) {
          this.client.setCoolingSetpoint(this.zone, tempF);
        } else {
          this.client.setHeatingSetpoint(this.zone, tempF);
        }
      }
      this.platform.log.info(`Zone ${this.zone}: Set target temp to ${tempF}°F`);
    });
  }

  private setTargetState(value: CharacteristicValue): void {
    const hkState = value as number;
    let symphonyMode: number;

    switch (hkState) {
      case this.Characteristic.TargetHeatingCoolingState.OFF:
        symphonyMode = MODE.OFF;
        break;
      case this.Characteristic.TargetHeatingCoolingState.HEAT:
        symphonyMode = MODE.HEAT;
        break;
      case this.Characteristic.TargetHeatingCoolingState.COOL:
        symphonyMode = MODE.COOL;
        break;
      case this.Characteristic.TargetHeatingCoolingState.AUTO:
        symphonyMode = MODE.AUTO;
        break;
      default:
        symphonyMode = MODE.AUTO;
    }

    this.client.setMode(this.zone, symphonyMode);
    this.platform.log.info(`Zone ${this.zone}: Set mode to ${symphonyMode}`);
  }

  private setCoolingThreshold(value: CharacteristicValue): void {
    const data = this.getZoneData();
    if (!data) return;

    const tempF = this.cToF(value as number);
    if (Math.round(tempF) === Math.round(data.coolingSetpoint)) return;

    this.debouncedWrite(`z${this.zone}-cool`, () => {
      this.client.setCoolingSetpoint(this.zone, tempF);
      this.platform.log.info(`Zone ${this.zone}: Set cooling setpoint to ${tempF}°F`);
    });
  }

  private setHeatingThreshold(value: CharacteristicValue): void {
    const data = this.getZoneData();
    if (!data) return;

    const tempF = this.cToF(value as number);
    if (Math.round(tempF) === Math.round(data.heatingSetpoint)) return;

    this.debouncedWrite(`z${this.zone}-heat`, () => {
      this.client.setHeatingSetpoint(this.zone, tempF);
      this.platform.log.info(`Zone ${this.zone}: Set heating setpoint to ${tempF}°F`);
    });
  }

  // -- Helpers --

  private mapCurrentState(): number {
    const modeOp = this.client.currentData.modeOfOperation;
    switch (modeOp) {
      case MODE_OF_OPERATION.COOLING_1:
      case MODE_OF_OPERATION.COOLING_2:
        return this.Characteristic.CurrentHeatingCoolingState.COOL;
      case MODE_OF_OPERATION.HEATING_1:
      case MODE_OF_OPERATION.HEATING_2:
      case MODE_OF_OPERATION.EHEAT:
      case MODE_OF_OPERATION.AUX_HEAT:
      case MODE_OF_OPERATION.REHEAT:
        return this.Characteristic.CurrentHeatingCoolingState.HEAT;
      default:
        return this.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  private mapTargetState(symphonyMode: number): number {
    switch (symphonyMode) {
      case MODE.OFF:
        return this.Characteristic.TargetHeatingCoolingState.OFF;
      case MODE.HEAT:
      case MODE.EHEAT:
        return this.Characteristic.TargetHeatingCoolingState.HEAT;
      case MODE.COOL:
        return this.Characteristic.TargetHeatingCoolingState.COOL;
      case MODE.AUTO:
        return this.Characteristic.TargetHeatingCoolingState.AUTO;
      default:
        return this.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  private debouncedWrite(key: string, fn: () => void): void {
    const existing = this.writeTimers.get(key);
    if (existing) clearTimeout(existing);
    this.writeTimers.set(
      key,
      setTimeout(() => {
        this.writeTimers.delete(key);
        fn();
      }, WRITE_DEBOUNCE_MS),
    );
  }

  // Fahrenheit to Celsius
  private fToC(f: number): number {
    return Math.round(((f - 32) * 5) / 9 * 10) / 10;
  }

  // Celsius to Fahrenheit
  private cToF(c: number): number {
    return Math.round((c * 9) / 5 + 32);
  }
}
