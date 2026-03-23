import { API } from "homebridge";
import { SymphonyPlatform } from "./platform.js";

export const PLUGIN_NAME = "homebridge-waterfurnace-symphony";
export const PLATFORM_NAME = "WaterFurnaceSymphony";

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, SymphonyPlatform);
};
