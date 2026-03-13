"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymphonyPlatform = void 0;
const index_1 = require("./index");
const symphony_client_1 = require("./symphony-client");
const thermostat_accessory_1 = require("./thermostat-accessory");
class SymphonyPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = [];
        this.thermostatAccessories = [];
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.zoneNames = config.zoneNames || {};
        this.client = new symphony_client_1.SymphonyClient(config.email, config.password);
        this.client.on("log", (msg) => this.log.debug(msg));
        this.client.on("zonesDiscovered", (numZones) => {
            this.log.info(`Discovered ${numZones} zones`);
            this.setupAccessories(numZones);
        });
        this.client.on("dataUpdate", () => {
            for (const acc of this.thermostatAccessories) {
                acc.updateFromData();
            }
        });
        this.client.on("disconnected", () => {
            this.log.warn("Disconnected from Symphony, will reconnect");
        });
        this.api.on("didFinishLaunching", () => {
            this.log.info("Connecting to WaterFurnace Symphony...");
            this.client.connect().catch((err) => {
                this.log.error(`Failed to connect: ${err.message}`);
            });
        });
    }
    configureAccessory(accessory) {
        this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
        this.accessories.push(accessory);
    }
    setupAccessories(numZones) {
        for (let zone = 1; zone <= numZones; zone++) {
            const name = this.zoneNames[`z${zone}`] || `Zone ${zone}`;
            const uuid = this.api.hap.uuid.generate(`waterfurnace-${this.client.gatewayId}-zone-${zone}`);
            let accessory = this.accessories.find((a) => a.UUID === uuid);
            if (!accessory) {
                this.log.info(`Adding new accessory: ${name}`);
                accessory = new this.api.platformAccessory(name, uuid);
                accessory.context.zone = zone;
                this.api.registerPlatformAccessories(index_1.PLUGIN_NAME, index_1.PLATFORM_NAME, [accessory]);
                this.accessories.push(accessory);
            }
            accessory.context.zone = zone;
            const thermostat = new thermostat_accessory_1.ThermostatAccessory(this, accessory, this.client, zone);
            this.thermostatAccessories.push(thermostat);
        }
        // Remove stale accessories
        const validUUIDs = new Set();
        for (let zone = 1; zone <= numZones; zone++) {
            validUUIDs.add(this.api.hap.uuid.generate(`waterfurnace-${this.client.gatewayId}-zone-${zone}`));
        }
        const stale = this.accessories.filter((a) => !validUUIDs.has(a.UUID));
        if (stale.length > 0) {
            this.log.info(`Removing ${stale.length} stale accessories`);
            this.api.unregisterPlatformAccessories(index_1.PLUGIN_NAME, index_1.PLATFORM_NAME, stale);
        }
    }
}
exports.SymphonyPlatform = SymphonyPlatform;
