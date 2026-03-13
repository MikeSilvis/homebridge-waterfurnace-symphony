import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./index";
import { SymphonyClient } from "./symphony-client";
import { ThermostatAccessory } from "./thermostat-accessory";

export class SymphonyPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private client: SymphonyClient;
  private thermostatAccessories: ThermostatAccessory[] = [];
  private zoneNames: Record<string, string>;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!config.email || !config.password) {
      this.log.error("Missing email or password in plugin config — plugin will not start");
      this.client = null as unknown as SymphonyClient;
      this.zoneNames = {};
      return;
    }

    this.zoneNames = config.zoneNames || {};
    this.client = new SymphonyClient(config.email, config.password);

    this.client.on("log", (msg: string) => this.log.debug(msg));

    this.client.on("zonesDiscovered", (numZones: number) => {
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

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  private setupAccessories(numZones: number): void {
    for (let zone = 1; zone <= numZones; zone++) {
      const name = this.zoneNames[`z${zone}`] || `Zone ${zone}`;
      const uuid = this.api.hap.uuid.generate(`waterfurnace-${this.client.gatewayId}-zone-${zone}`);

      let accessory = this.accessories.find((a) => a.UUID === uuid);
      if (!accessory) {
        this.log.info(`Adding new accessory: ${name}`);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.zone = zone;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      accessory.context.zone = zone;
      const thermostat = new ThermostatAccessory(this, accessory, this.client, zone);
      this.thermostatAccessories.push(thermostat);
    }

    // Remove stale accessories
    const validUUIDs = new Set<string>();
    for (let zone = 1; zone <= numZones; zone++) {
      validUUIDs.add(this.api.hap.uuid.generate(`waterfurnace-${this.client.gatewayId}-zone-${zone}`));
    }
    const stale = this.accessories.filter((a) => !validUUIDs.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
