import { PlatformAccessory, Service, Characteristic, CharacteristicValue } from "homebridge";
import { SymphonyPlatform } from "./platform.js";
import { SymphonyClient, MODE, MODE_OF_OPERATION, ZoneData } from "./symphony-client.js";

const WRITE_DEBOUNCE_MS = 500;

// Symphony needs roughly 10-15 seconds to reflect a write back in the registers
// it serves to readers. Until it does, we report the value the user asked for
// rather than the stale one, otherwise every poll snaps HomeKit back to the old
// setpoint and the adjustment looks like it never took.
const PENDING_WRITE_TTL_MS = 60_000;

// Symphony's setpoint registers drift off the value that was written to them
// without anything on the system actually changing, which is what made manual
// adjustments look like they never took. Treat the HomeKit setpoint as the
// source of truth and put it back when Symphony wanders off it.
const REASSERT_LIMIT = 3;
// A jump larger than this is a real change someone made elsewhere, not the
// register drifting, so follow it instead of fighting it.
const REASSERT_MAX_DRIFT_F = 3;

type PendingKey = "heat" | "cool" | "mode";

interface PendingWrite {
  value: number;
  expiresAt: number;
}

export class ThermostatAccessory {
  private service: Service;
  private humidityService: Service;
  private writeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastSnapshot: string | undefined;

  // Values we have asked Symphony for but have not yet seen echoed back.
  private pending: Map<PendingKey, PendingWrite> = new Map();
  // What HomeKit asked for, kept after Symphony confirms it so we can tell when
  // Symphony has drifted off it. Setpoints only — see reconcileKey for why mode
  // is left alone.
  private desired: Map<PendingKey, number> = new Map();
  private reassertAttempts: Map<PendingKey, number> = new Map();

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

    this.reconcile(data);

    const snapshot =
      `${data.currentTemp}|${data.heatingSetpoint}|${data.coolingSetpoint}|${data.humidity}|${data.activeMode}`;
    if (snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      this.platform.log.debug(
        `Zone ${this.zone}: Current temp ${data.currentTemp}°F (${this.fToC(data.currentTemp)}°C), ` +
        `heat setpoint ${data.heatingSetpoint}°F, cool setpoint ${data.coolingSetpoint}°F, ` +
        `humidity ${data.humidity}%, mode ${data.activeMode}`,
      );
    }

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
      this.mapTargetState(this.effectiveMode(data)),
    );
    this.service.updateCharacteristic(
      this.Characteristic.CoolingThresholdTemperature,
      this.fToC(this.effectiveCool(data)),
    );
    this.service.updateCharacteristic(
      this.Characteristic.HeatingThresholdTemperature,
      this.fToC(this.effectiveHeat(data)),
    );
    this.humidityService.updateCharacteristic(
      this.Characteristic.CurrentRelativeHumidity,
      data.humidity,
    );
  }

  private getZoneData(): ZoneData | undefined {
    return this.client.currentData.zones.get(this.zone);
  }

  // -- Pending write tracking --

  // Compare what Symphony now reports against what we asked it for, retiring
  // pending writes that landed and reporting ones that did not.
  private reconcile(data: ZoneData): void {
    this.reconcileKey("heat", data.heatingSetpoint, "heating setpoint");
    this.reconcileKey("cool", data.coolingSetpoint, "cooling setpoint");
    this.reconcileKey("mode", data.activeMode, "mode");
  }

  private reconcileKey(key: PendingKey, reported: number, label: string): void {
    const pending = this.pending.get(key);

    if (pending) {
      if (Math.round(reported) === Math.round(pending.value)) {
        this.pending.delete(key);
        this.reassertAttempts.set(key, 0);
        this.platform.log.debug(`Zone ${this.zone}: ${label} ${pending.value} confirmed by Symphony`);
      } else if (Date.now() > pending.expiresAt) {
        this.pending.delete(key);
        this.platform.log.warn(
          `Zone ${this.zone}: ${label} ${pending.value} not confirmed after ` +
          `${PENDING_WRITE_TTL_MS / 1000}s — Symphony reports ${reported}`,
        );
        this.reassert(key, reported, label);
      }
      return;
    }

    // Mode is deliberately not re-asserted: activemode is the mode the system
    // resolved to, so asking for Auto and reading back Cool is correct rather
    // than drift, and re-writing it would fight the equipment.
    const desired = this.desired.get(key);
    if (key === "mode" || desired === undefined) return;
    if (Math.round(reported) === Math.round(desired)) return;

    if (Math.abs(reported - desired) > REASSERT_MAX_DRIFT_F) {
      this.desired.delete(key);
      this.reassertAttempts.delete(key);
      this.platform.log.info(
        `Zone ${this.zone}: ${label} changed to ${reported} outside HomeKit — following it`,
      );
      return;
    }

    this.platform.log.warn(
      `Zone ${this.zone}: Symphony moved ${label} from ${desired} to ${reported} on its own — ` +
      `re-applying ${desired}`,
    );
    this.reassert(key, reported, label);
  }

  // Put the HomeKit setpoint back, giving up after a few tries so we never sit
  // in a write loop against a value Symphony refuses to take.
  private reassert(key: PendingKey, reported: number, label: string): void {
    const desired = this.desired.get(key);
    if (key === "mode" || desired === undefined) return;

    const attempts = (this.reassertAttempts.get(key) ?? 0) + 1;
    if (attempts > REASSERT_LIMIT) {
      this.desired.delete(key);
      this.reassertAttempts.delete(key);
      this.platform.log.warn(
        `Zone ${this.zone}: gave up re-applying ${label} ${desired} after ${REASSERT_LIMIT} ` +
        `attempts — showing ${reported}`,
      );
      return;
    }

    this.reassertAttempts.set(key, attempts);
    this.sendWrite(
      key,
      desired,
      `Re-applying ${label} ${desired}°F (attempt ${attempts}/${REASSERT_LIMIT})`,
    );
  }

  private pendingValue(key: PendingKey): number | undefined {
    const pending = this.pending.get(key);
    if (!pending) return undefined;
    if (Date.now() > pending.expiresAt) return undefined;
    return pending.value;
  }

  private effectiveHeat(data: ZoneData): number {
    return this.pendingValue("heat") ?? data.heatingSetpoint;
  }

  private effectiveCool(data: ZoneData): number {
    return this.pendingValue("cool") ?? data.coolingSetpoint;
  }

  private effectiveMode(data: ZoneData): number {
    return this.pendingValue("mode") ?? data.activeMode;
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
    const mode = this.effectiveMode(data);
    if (mode === MODE.COOL) {
      return this.fToC(this.effectiveCool(data));
    } else if (mode === MODE.HEAT || mode === MODE.EHEAT) {
      return this.fToC(this.effectiveHeat(data));
    }
    // Auto or Off - use midpoint
    return this.fToC((this.effectiveHeat(data) + this.effectiveCool(data)) / 2);
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
    return data ? this.fToC(this.effectiveCool(data)) : 25;
  }

  private getHeatingThreshold(): CharacteristicValue {
    const data = this.getZoneData();
    return data ? this.fToC(this.effectiveHeat(data)) : 20;
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
    const mode = this.effectiveMode(data);

    if (mode === MODE.COOL) {
      this.writeSetpoint("cool", tempF, data);
    } else if (mode === MODE.HEAT || mode === MODE.EHEAT) {
      this.writeSetpoint("heat", tempF, data);
    } else {
      // Auto/Off: HomeKit hands us one target but the system holds a heat/cool
      // band. Moving a single side would shift the midpoint by half the change,
      // so the target could never read back as what was asked for. Slide the
      // whole band instead and keep its width.
      const half = (this.effectiveCool(data) - this.effectiveHeat(data)) / 2;
      this.writeSetpoint("heat", tempF - half, data);
      this.writeSetpoint("cool", tempF + half, data);
    }
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

    const data = this.getZoneData();
    if (data && this.effectiveMode(data) === symphonyMode) return;

    this.sendWrite("mode", symphonyMode, `Set mode to ${symphonyMode}`);
  }

  private setCoolingThreshold(value: CharacteristicValue): void {
    const data = this.getZoneData();
    if (!data) return;
    this.writeSetpoint("cool", this.cToF(value as number), data);
  }

  private setHeatingThreshold(value: CharacteristicValue): void {
    const data = this.getZoneData();
    if (!data) return;
    this.writeSetpoint("heat", this.cToF(value as number), data);
  }

  // Record the requested setpoint straight away so HomeKit keeps showing it
  // while Symphony catches up, then send the write.
  private writeSetpoint(key: "heat" | "cool", tempF: number, data: ZoneData): void {
    const rounded = Math.round(tempF);
    const current = key === "cool" ? this.effectiveCool(data) : this.effectiveHeat(data);
    if (rounded === Math.round(current)) return;

    const label = key === "cool" ? "cooling setpoint" : "heating setpoint";
    this.desired.set(key, rounded);
    this.reassertAttempts.set(key, 0);
    this.sendWrite(key, rounded, `Set ${label} to ${rounded}°F`);
  }

  // Single write path for both user changes and re-assertions, so every write
  // is debounced, tracked as pending, and survives a closed WebSocket.
  private sendWrite(key: PendingKey, value: number, message: string): void {
    this.pending.set(key, { value, expiresAt: Date.now() + PENDING_WRITE_TTL_MS });

    this.debouncedWrite(`z${this.zone}-${key}`, () => {
      try {
        if (key === "cool") {
          this.client.setCoolingSetpoint(this.zone, value);
        } else if (key === "heat") {
          this.client.setHeatingSetpoint(this.zone, value);
        } else {
          this.client.setMode(this.zone, value);
        }
        this.platform.log.info(`Zone ${this.zone}: ${message}`);
      } catch (e) {
        this.pending.delete(key);
        this.platform.log.error(`Zone ${this.zone}: write failed: ${(e as Error).message}`);
      }
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
