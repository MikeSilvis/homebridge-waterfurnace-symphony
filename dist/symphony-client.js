"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymphonyClient = exports.MODE_OF_OPERATION = exports.MODE = void 0;
const https_1 = __importDefault(require("https"));
const ws_1 = __importDefault(require("ws"));
const events_1 = require("events");
const LOGIN_URL = "https://symphony.mywaterfurnace.com/account/login";
const WS_URL = "wss://awlclientproxy.mywaterfurnace.com:443";
const USER_AGENT = "homebridge-waterfurnace-symphony/1.0";
const READ_INTERVAL_MS = 15000;
const WS_TIMEOUT_MS = 10000;
// Mode enums matching Symphony's values
exports.MODE = {
    OFF: 0,
    AUTO: 1,
    COOL: 2,
    HEAT: 3,
    EHEAT: 4,
};
exports.MODE_OF_OPERATION = {
    STANDBY: 0,
    FAN_ONLY: 1,
    COOLING_1: 2,
    COOLING_2: 3,
    REHEAT: 4,
    HEATING_1: 5,
    HEATING_2: 6,
    EHEAT: 7,
    AUX_HEAT: 8,
    LOCKOUT: 9,
};
class SymphonyClient extends events_1.EventEmitter {
    constructor(user, password) {
        super();
        this.sessionId = null;
        this.ws = null;
        this.tid = 1;
        this.gwid = null;
        this.numZones = 1;
        this.readTimer = null;
        this.reconnectTimer = null;
        this.connected = false;
        this.lastData = { zones: new Map(), modeOfOperation: 0, online: false };
        this.user = user;
        this.password = password;
    }
    get gatewayId() {
        return this.gwid;
    }
    get zoneCount() {
        return this.numZones;
    }
    get currentData() {
        return this.lastData;
    }
    async connect() {
        await this.httpLogin();
        await this.connectWebSocket();
    }
    disconnect() {
        this.stopPolling();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
    async setHeatingSetpoint(zone, temp) {
        const reg = this.numZones > 1 ? `iz2_z${zone}_heatingsp_write` : "heatingsp_write";
        await this.writeValue(reg, Math.round(temp));
    }
    async setCoolingSetpoint(zone, temp) {
        const reg = this.numZones > 1 ? `iz2_z${zone}_coolingsp_write` : "coolingsp_write";
        await this.writeValue(reg, Math.round(temp));
    }
    async setMode(zone, mode) {
        const reg = this.numZones > 1 ? `iz2_z${zone}_activemode_write` : "activemode_write";
        await this.writeValue(reg, mode);
    }
    async setFanMode(zone, fanMode) {
        const reg = this.numZones > 1 ? `iz2_z${zone}_fanmode_write` : "fanmode_write";
        await this.writeValue(reg, fanMode);
    }
    async setHumiditySetpoint(value) {
        await this.writeValue("iz2_humidification_setpoint_write", Math.round(value));
    }
    async httpLogin() {
        return new Promise((resolve, reject) => {
            const postData = new URLSearchParams({
                emailaddress: this.user,
                password: this.password,
                op: "login",
                redirect: "/",
            }).toString();
            const url = new URL(LOGIN_URL);
            const options = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(postData),
                    "User-Agent": USER_AGENT,
                    Cookie: "legal-acknowledge=yes; temp_unit=f",
                },
            };
            const req = https_1.default.request(options, (res) => {
                const cookies = res.headers["set-cookie"];
                if (cookies) {
                    for (const cookie of cookies) {
                        const match = cookie.match(/sessionid=([^;]+)/);
                        if (match) {
                            this.sessionId = match[1];
                        }
                    }
                }
                // Consume response body
                res.on("data", () => { });
                res.on("end", () => {
                    if (this.sessionId) {
                        this.emit("log", "HTTP login successful");
                        resolve();
                    }
                    else {
                        reject(new Error("Login failed: no session cookie received"));
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(WS_TIMEOUT_MS, () => {
                req.destroy(new Error("Login request timed out"));
            });
            req.write(postData);
            req.end();
        });
    }
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            this.ws = new ws_1.default(WS_URL, {
                rejectUnauthorized: false,
                headers: { "User-Agent": USER_AGENT },
            });
            const timeout = setTimeout(() => {
                reject(new Error("WebSocket connection timed out"));
                this.ws?.close();
            }, WS_TIMEOUT_MS);
            this.ws.on("open", () => {
                clearTimeout(timeout);
                this.emit("log", "WebSocket connected, sending login");
                this.wsLogin();
            });
            this.ws.on("message", (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.handleMessage(msg, resolve);
                }
                catch (e) {
                    this.emit("log", `Failed to parse WS message: ${e}`);
                }
            });
            this.ws.on("close", () => {
                this.connected = false;
                this.stopPolling();
                this.emit("log", "WebSocket closed");
                this.emit("disconnected");
                this.scheduleReconnect();
            });
            this.ws.on("error", (err) => {
                this.emit("log", `WebSocket error: ${err.message}`);
                if (!this.connected) {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }
    wsLogin() {
        this.sendCommand({
            cmd: "login",
            sessionid: this.sessionId,
            source: "consumer dashboard",
        });
    }
    handleMessage(msg, resolveConnect) {
        const rsp = msg.rsp;
        const err = msg.err;
        if (err && err.length > 0) {
            this.emit("log", `Server error: ${err}`);
            return;
        }
        if (rsp === "login") {
            this.connected = true;
            this.emit("log", "WebSocket login successful");
            // Extract gateway info from login response
            const locations = msg.locations;
            if (locations && locations.length > 0) {
                const gateways = locations[0].gateways;
                if (gateways && gateways.length > 0) {
                    this.gwid = gateways[0].gwid;
                    this.emit("log", `Gateway ID: ${this.gwid}`);
                }
            }
            // If we already know the gateway from config, just start reading
            if (this.gwid) {
                this.readStatType();
                resolveConnect?.();
            }
        }
        else if (rsp === "read") {
            this.handleReadResponse(msg);
        }
        else if (rsp === "write") {
            this.emit("log", "Write acknowledged");
            // Re-read after write to get updated values
            setTimeout(() => this.readAllZones(), 2000);
        }
    }
    handleReadResponse(msg) {
        // Handle stat type discovery
        if (msg.awltstattype !== undefined) {
            const tstatType = msg.awltstattype;
            if (tstatType === 200) {
                // IZ2 system - get zone count
                this.readZoneCount();
            }
            else {
                this.numZones = 1;
                this.startPolling();
            }
            return;
        }
        // Handle zone count discovery
        if (msg.iz2_max_zones !== undefined) {
            this.numZones = msg.iz2_max_zones;
            this.emit("log", `System has ${this.numZones} zones`);
            this.emit("zonesDiscovered", this.numZones);
            this.startPolling();
            return;
        }
        // Handle zone data
        this.parseZoneData(msg);
        this.emit("dataUpdate", this.lastData);
    }
    parseZoneData(msg) {
        const isIZ2 = this.numZones > 1;
        this.lastData.modeOfOperation = msg.modeofoperation ?? this.lastData.modeOfOperation;
        this.lastData.online = true;
        // System-level data
        if (msg.leavingairtemp !== undefined)
            this.lastData.supplyAirTemp = msg.leavingairtemp;
        if (msg.enteringwatertemp !== undefined)
            this.lastData.enteringWaterTemp = msg.enteringwatertemp;
        if (msg.leavingwatertemp !== undefined)
            this.lastData.leavingWaterTemp = msg.leavingwatertemp;
        if (msg.compressorpower !== undefined)
            this.lastData.compressorPower = msg.compressorpower;
        if (msg.fanpower !== undefined)
            this.lastData.fanPower = msg.fanpower;
        if (msg.totalunitpower !== undefined)
            this.lastData.totalPower = msg.totalunitpower;
        // Humidity
        const humidity = msg[isIZ2 ? "iz2_humidity" : "humidity"];
        if (isIZ2) {
            for (let z = 1; z <= this.numZones; z++) {
                const activeSettings = msg[`iz2_z${z}_activesettings`];
                if (!activeSettings)
                    continue;
                const zone = {
                    currentTemp: msg[`iz2_z${z}_roomtemp`] ?? 0,
                    heatingSetpoint: activeSettings[`iz2_z${z}_heatingsp_read`] ?? 70,
                    coolingSetpoint: activeSettings[`iz2_z${z}_coolingsp_read`] ?? 75,
                    activeMode: activeSettings[`iz2_z${z}_activemode`] ?? 1,
                    fanMode: activeSettings[`iz2_z${z}_fanmode_read`] ?? 0,
                    humidity: humidity ?? 0,
                };
                this.lastData.zones.set(z, zone);
            }
        }
        else {
            const activeSettings = msg.activesettings;
            const zone = {
                currentTemp: msg.tstatroomtemp ?? msg.roomtemp ?? 0,
                heatingSetpoint: msg.tstatheatingsetpoint ?? activeSettings?.heatingsp_read ?? 70,
                coolingSetpoint: msg.tstatcoolingsetpoint ?? activeSettings?.coolingsp_read ?? 75,
                activeMode: activeSettings?.activemode ?? 1,
                fanMode: activeSettings?.fanmode_read ?? 0,
                humidity: humidity ?? 0,
            };
            this.lastData.zones.set(1, zone);
        }
    }
    readStatType() {
        this.sendCommand({
            cmd: "read",
            awlid: this.gwid,
            source: "tstat",
            zone: 0,
            rlist: ["AWLTStatType"],
        });
    }
    readZoneCount() {
        this.sendCommand({
            cmd: "read",
            awlid: this.gwid,
            source: "tstat",
            zone: 0,
            rlist: ["iz2_max_zones"],
        });
    }
    readAllZones() {
        const isIZ2 = this.numZones > 1;
        const rlist = [
            "AWLABCType",
            "ModeOfOperation",
            "compressorpower",
            "fanpower",
            "totalunitpower",
            "leavingairtemp",
            "enteringwatertemp",
            "leavingwatertemp",
        ];
        if (isIZ2) {
            rlist.push("iz2_humidity");
            rlist.push("iz2_humidity_offset_settings");
            for (let z = 1; z <= this.numZones; z++) {
                rlist.push(`iz2_z${z}_activesettings`);
                rlist.push(`iz2_z${z}_roomtemp`);
            }
        }
        else {
            rlist.push("humidity");
            rlist.push("humidity_offset_settings");
            rlist.push("tstatroomtemp");
            rlist.push("tstatactivemode");
            rlist.push("tstatheatingsetpoint");
            rlist.push("tstatcoolingsetpoint");
            rlist.push("activesettings");
            rlist.push("roomtemp");
        }
        this.sendCommand({
            cmd: "read",
            awlid: this.gwid,
            source: "tstat",
            zone: 0,
            rlist,
        });
    }
    async writeValue(register, value) {
        if (!this.connected) {
            throw new Error("Not connected to Symphony");
        }
        const cmd = {
            cmd: "write",
            awlid: this.gwid,
            source: "tstat",
            [register]: value,
        };
        this.sendCommand(cmd);
    }
    sendCommand(cmd) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            this.emit("log", "Cannot send command: WebSocket not open");
            return;
        }
        this.tid = (this.tid + 1) % 100;
        cmd.tid = this.tid;
        this.ws.send(JSON.stringify(cmd));
    }
    startPolling() {
        this.stopPolling();
        // Read immediately
        this.readAllZones();
        // Then poll every READ_INTERVAL_MS
        this.readTimer = setInterval(() => this.readAllZones(), READ_INTERVAL_MS);
    }
    stopPolling() {
        if (this.readTimer) {
            clearInterval(this.readTimer);
            this.readTimer = null;
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        this.emit("log", "Scheduling reconnect in 30 seconds");
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                this.emit("log", "Reconnected successfully");
            }
            catch (e) {
                this.emit("log", `Reconnect failed: ${e}`);
                this.scheduleReconnect();
            }
        }, 30000);
    }
}
exports.SymphonyClient = SymphonyClient;
