"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThermostatAccessory = void 0;
const symphony_client_1 = require("./symphony-client");
class ThermostatAccessory {
    constructor(platform, accessory, client, zone) {
        this.platform = platform;
        this.accessory = accessory;
        this.client = client;
        this.zone = zone;
        this.Characteristic = platform.Characteristic;
        // Accessory info
        this.accessory
            .getService(platform.Service.AccessoryInformation)
            .setCharacteristic(platform.Characteristic.Manufacturer, "WaterFurnace")
            .setCharacteristic(platform.Characteristic.Model, "Symphony IZ2")
            .setCharacteristic(platform.Characteristic.SerialNumber, `${client.gatewayId}-Z${zone}`);
        // Thermostat service
        this.service =
            this.accessory.getService(platform.Service.Thermostat) ||
                this.accessory.addService(platform.Service.Thermostat);
        this.service.setCharacteristic(platform.Characteristic.Name, accessory.displayName);
        // Temperature display units (Fahrenheit)
        this.service.setCharacteristic(platform.Characteristic.TemperatureDisplayUnits, platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
        // Current temperature (read-only)
        this.service
            .getCharacteristic(platform.Characteristic.CurrentTemperature)
            .onGet(() => this.getCurrentTemp());
        // Target temperature (read/write)
        this.service
            .getCharacteristic(platform.Characteristic.TargetTemperature)
            .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 })
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
            .setProps({ minValue: 10, maxValue: 35, minStep: 0.5 })
            .onGet(() => this.getCoolingThreshold())
            .onSet((value) => this.setCoolingThreshold(value));
        // Heating threshold (for Auto mode)
        this.service
            .getCharacteristic(platform.Characteristic.HeatingThresholdTemperature)
            .setProps({ minValue: 4, maxValue: 32, minStep: 0.5 })
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
    updateFromData() {
        const data = this.getZoneData();
        if (!data)
            return;
        this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.fToC(data.currentTemp));
        this.service.updateCharacteristic(this.Characteristic.TargetTemperature, this.getTargetTempValue(data));
        this.service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.mapCurrentState());
        this.service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mapTargetState(data.activeMode));
        this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.fToC(data.coolingSetpoint));
        this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.fToC(data.heatingSetpoint));
        this.humidityService.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, data.humidity);
    }
    getZoneData() {
        return this.client.currentData.zones.get(this.zone);
    }
    // -- Getters --
    getCurrentTemp() {
        const data = this.getZoneData();
        return data ? this.fToC(data.currentTemp) : 20;
    }
    getTargetTemp() {
        const data = this.getZoneData();
        if (!data)
            return 21;
        return this.getTargetTempValue(data);
    }
    getTargetTempValue(data) {
        // In Auto mode, use the midpoint; in Heat/Cool use the respective setpoint
        if (data.activeMode === symphony_client_1.MODE.COOL) {
            return this.fToC(data.coolingSetpoint);
        }
        else if (data.activeMode === symphony_client_1.MODE.HEAT || data.activeMode === symphony_client_1.MODE.EHEAT) {
            return this.fToC(data.heatingSetpoint);
        }
        // Auto or Off - use midpoint
        return this.fToC((data.heatingSetpoint + data.coolingSetpoint) / 2);
    }
    getCurrentState() {
        return this.mapCurrentState();
    }
    getTargetState() {
        const data = this.getZoneData();
        if (!data)
            return this.Characteristic.TargetHeatingCoolingState.OFF;
        return this.mapTargetState(data.activeMode);
    }
    getCoolingThreshold() {
        const data = this.getZoneData();
        return data ? this.fToC(data.coolingSetpoint) : 25;
    }
    getHeatingThreshold() {
        const data = this.getZoneData();
        return data ? this.fToC(data.heatingSetpoint) : 20;
    }
    getHumidity() {
        const data = this.getZoneData();
        return data ? data.humidity : 50;
    }
    // -- Setters --
    async setTargetTemp(value) {
        const data = this.getZoneData();
        if (!data)
            return;
        const tempF = this.cToF(value);
        if (data.activeMode === symphony_client_1.MODE.COOL) {
            await this.client.setCoolingSetpoint(this.zone, tempF);
        }
        else if (data.activeMode === symphony_client_1.MODE.HEAT || data.activeMode === symphony_client_1.MODE.EHEAT) {
            await this.client.setHeatingSetpoint(this.zone, tempF);
        }
        else {
            // Auto mode - adjust the closer setpoint
            const midpoint = (data.heatingSetpoint + data.coolingSetpoint) / 2;
            if (tempF >= midpoint) {
                await this.client.setCoolingSetpoint(this.zone, tempF);
            }
            else {
                await this.client.setHeatingSetpoint(this.zone, tempF);
            }
        }
        this.platform.log.info(`Zone ${this.zone}: Set target temp to ${tempF}°F`);
    }
    async setTargetState(value) {
        const hkState = value;
        let symphonyMode;
        switch (hkState) {
            case this.Characteristic.TargetHeatingCoolingState.OFF:
                symphonyMode = symphony_client_1.MODE.OFF;
                break;
            case this.Characteristic.TargetHeatingCoolingState.HEAT:
                symphonyMode = symphony_client_1.MODE.HEAT;
                break;
            case this.Characteristic.TargetHeatingCoolingState.COOL:
                symphonyMode = symphony_client_1.MODE.COOL;
                break;
            case this.Characteristic.TargetHeatingCoolingState.AUTO:
                symphonyMode = symphony_client_1.MODE.AUTO;
                break;
            default:
                symphonyMode = symphony_client_1.MODE.AUTO;
        }
        await this.client.setMode(this.zone, symphonyMode);
        this.platform.log.info(`Zone ${this.zone}: Set mode to ${symphonyMode}`);
    }
    async setCoolingThreshold(value) {
        const tempF = this.cToF(value);
        await this.client.setCoolingSetpoint(this.zone, tempF);
        this.platform.log.info(`Zone ${this.zone}: Set cooling setpoint to ${tempF}°F`);
    }
    async setHeatingThreshold(value) {
        const tempF = this.cToF(value);
        await this.client.setHeatingSetpoint(this.zone, tempF);
        this.platform.log.info(`Zone ${this.zone}: Set heating setpoint to ${tempF}°F`);
    }
    // -- Helpers --
    mapCurrentState() {
        const modeOp = this.client.currentData.modeOfOperation;
        switch (modeOp) {
            case symphony_client_1.MODE_OF_OPERATION.COOLING_1:
            case symphony_client_1.MODE_OF_OPERATION.COOLING_2:
                return this.Characteristic.CurrentHeatingCoolingState.COOL;
            case symphony_client_1.MODE_OF_OPERATION.HEATING_1:
            case symphony_client_1.MODE_OF_OPERATION.HEATING_2:
            case symphony_client_1.MODE_OF_OPERATION.EHEAT:
            case symphony_client_1.MODE_OF_OPERATION.AUX_HEAT:
            case symphony_client_1.MODE_OF_OPERATION.REHEAT:
                return this.Characteristic.CurrentHeatingCoolingState.HEAT;
            default:
                return this.Characteristic.CurrentHeatingCoolingState.OFF;
        }
    }
    mapTargetState(symphonyMode) {
        switch (symphonyMode) {
            case symphony_client_1.MODE.OFF:
                return this.Characteristic.TargetHeatingCoolingState.OFF;
            case symphony_client_1.MODE.HEAT:
            case symphony_client_1.MODE.EHEAT:
                return this.Characteristic.TargetHeatingCoolingState.HEAT;
            case symphony_client_1.MODE.COOL:
                return this.Characteristic.TargetHeatingCoolingState.COOL;
            case symphony_client_1.MODE.AUTO:
                return this.Characteristic.TargetHeatingCoolingState.AUTO;
            default:
                return this.Characteristic.TargetHeatingCoolingState.AUTO;
        }
    }
    // Fahrenheit to Celsius
    fToC(f) {
        return Math.round(((f - 32) * 5) / 9 * 10) / 10;
    }
    // Celsius to Fahrenheit
    cToF(c) {
        return Math.round((c * 9) / 5 + 32);
    }
}
exports.ThermostatAccessory = ThermostatAccessory;
