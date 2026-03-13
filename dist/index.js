"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
const platform_1 = require("./platform");
exports.PLUGIN_NAME = "homebridge-waterfurnace-symphony";
exports.PLATFORM_NAME = "WaterFurnaceSymphony";
exports.default = (api) => {
    api.registerPlatform(exports.PLUGIN_NAME, exports.PLATFORM_NAME, platform_1.SymphonyPlatform);
};
