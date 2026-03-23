import https from "node:https";
import crypto from "node:crypto";
import WebSocket from "ws";
import { EventEmitter } from "node:events";

const LOGIN_URL = "https://symphony.mywaterfurnace.com/account/login";
const WS_URL = "wss://awlclientproxy.mywaterfurnace.com:443";
const USER_AGENT = "homebridge-waterfurnace-symphony/1.0";
const READ_INTERVAL_MS = 15_000;
const WS_TIMEOUT_MS = 10_000;

export interface ZoneData {
  currentTemp: number;
  heatingSetpoint: number;
  coolingSetpoint: number;
  activeMode: number; // 0=Off, 1=Auto, 2=Cool, 3=Heat, 4=E-Heat
  fanMode: number; // 0=Auto, 1=Continuous, 2=Intermittent
  humidity: number;
}

export interface SystemData {
  zones: Map<number, ZoneData>;
  modeOfOperation: number;
  outdoorTemp?: number;
  supplyAirTemp?: number;
  returnAirTemp?: number;
  enteringWaterTemp?: number;
  leavingWaterTemp?: number;
  compressorPower?: number;
  fanPower?: number;
  totalPower?: number;
  humiditySetpoint?: number;
  online: boolean;
}

// Mode enums matching Symphony's values
export const MODE = {
  OFF: 0,
  AUTO: 1,
  COOL: 2,
  HEAT: 3,
  EHEAT: 4,
} as const;

export const MODE_OF_OPERATION = {
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
} as const;

export class SymphonyClient extends EventEmitter {
  private user: string;
  private password: string;
  private sessionId: string | null = null;
  private ws: WebSocket | null = null;
  private tid = 1;
  private gwid: string | null = null;
  private numZones = 1;
  private readTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private lastData: SystemData = { zones: new Map(), modeOfOperation: 0, online: false };

  constructor(user: string, password: string) {
    super();
    this.user = user;
    this.password = password;
  }

  get gatewayId(): string | null {
    return this.gwid;
  }

  get zoneCount(): number {
    return this.numZones;
  }

  get currentData(): SystemData {
    return this.lastData;
  }

  async connect(): Promise<void> {
    await this.httpLogin();
    await this.connectWebSocket();
  }

  disconnect(): void {
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

  setHeatingSetpoint(zone: number, temp: number): void {
    const reg = this.numZones > 1 ? `iz2_z${zone}_heatingsp_write` : "heatingsp_write";
    this.writeValue(reg, Math.round(temp));
  }

  setCoolingSetpoint(zone: number, temp: number): void {
    const reg = this.numZones > 1 ? `iz2_z${zone}_coolingsp_write` : "coolingsp_write";
    this.writeValue(reg, Math.round(temp));
  }

  setMode(zone: number, mode: number): void {
    const reg = this.numZones > 1 ? `iz2_z${zone}_activemode_write` : "activemode_write";
    this.writeValue(reg, mode);
  }

  setFanMode(zone: number, fanMode: number): void {
    const reg = this.numZones > 1 ? `iz2_z${zone}_fanmode_write` : "fanmode_write";
    this.writeValue(reg, fanMode);
  }

  setHumiditySetpoint(value: number): void {
    this.writeValue("iz2_humidification_setpoint_write", Math.round(value));
  }

  private async httpLogin(): Promise<void> {
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        emailaddress: this.user,
        password: this.password,
        op: "login",
        redirect: "/",
      }).toString();

      const url = new URL(LOGIN_URL);
      const options: https.RequestOptions = {
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
        secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
        agent: new https.Agent({
          secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
        }),
      };

      const req = https.request(options, (res) => {
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
        res.on("data", () => {});
        res.on("end", () => {
          if (this.sessionId) {
            this.emit("log", "HTTP login successful");
            resolve();
          } else {
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

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const secureOptions = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
      this.ws = new WebSocket(WS_URL, {
        headers: { "User-Agent": USER_AGENT },
        secureOptions,
        agent: new https.Agent({ secureOptions }),
      });

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket connection timed out"));
        }
        this.ws?.close();
      }, WS_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.emit("log", "WebSocket connected, sending login");
        this.wsLogin();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          const onConnect = !settled
            ? () => {
                settled = true;
                resolve();
              }
            : undefined;
          this.handleMessage(msg, onConnect);
        } catch (e) {
          this.emit("log", `Failed to parse WS message: ${e}`);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.stopPolling();
        this.emit("log", "WebSocket closed");
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket closed before login completed"));
        } else {
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        this.emit("log", `WebSocket error: ${err.message}`);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private wsLogin(): void {
    this.sendCommand({
      cmd: "login",
      sessionid: this.sessionId,
      source: "consumer dashboard",
    });
  }

  private handleMessage(msg: Record<string, unknown>, resolveConnect?: (value: void) => void): void {
    const rsp = msg.rsp as string | undefined;
    const err = msg.err as string | undefined;

    if (err && err.length > 0) {
      this.emit("log", `Server error: ${err}`);
      return;
    }

    if (rsp === "login") {
      this.connected = true;
      this.emit("log", "WebSocket login successful");

      // Extract gateway info from login response
      const locations = msg.locations as Array<Record<string, unknown>> | undefined;
      if (locations && locations.length > 0) {
        const gateways = locations[0].gateways as Array<Record<string, unknown>> | undefined;
        if (gateways && gateways.length > 0) {
          this.gwid = gateways[0].gwid as string;
          this.emit("log", `Gateway ID: ${this.gwid}`);
        }
      }

      // If we already know the gateway from config, just start reading
      if (this.gwid) {
        this.readStatType();
        resolveConnect?.();
      }
    } else if (rsp === "read") {
      this.handleReadResponse(msg);
    } else if (rsp === "write") {
      this.emit("log", "Write acknowledged");
      // Re-read after write to get updated values
      setTimeout(() => this.readAllZones(), 2000);
    }
  }

  private handleReadResponse(msg: Record<string, unknown>): void {
    // Handle stat type discovery
    if (msg.awltstattype !== undefined) {
      const tstatType = msg.awltstattype as number;
      if (tstatType === 200) {
        // IZ2 system - get zone count
        this.readZoneCount();
      } else {
        this.numZones = 1;
        this.emit("zonesDiscovered", this.numZones);
        this.startPolling();
      }
      return;
    }

    // Handle zone count discovery
    if (msg.iz2_max_zones !== undefined) {
      this.numZones = msg.iz2_max_zones as number;
      this.emit("log", `System has ${this.numZones} zones`);
      this.emit("zonesDiscovered", this.numZones);
      this.startPolling();
      return;
    }

    // Handle zone data
    this.parseZoneData(msg);
    this.emit("dataUpdate", this.lastData);
  }

  private parseZoneData(msg: Record<string, unknown>): void {
    const isIZ2 = this.numZones > 1;

    this.lastData.modeOfOperation = (msg.modeofoperation as number) ?? this.lastData.modeOfOperation;
    this.lastData.online = true;

    // System-level data
    if (msg.leavingairtemp !== undefined) this.lastData.supplyAirTemp = msg.leavingairtemp as number;
    if (msg.enteringwatertemp !== undefined) this.lastData.enteringWaterTemp = msg.enteringwatertemp as number;
    if (msg.leavingwatertemp !== undefined) this.lastData.leavingWaterTemp = msg.leavingwatertemp as number;
    if (msg.compressorpower !== undefined) this.lastData.compressorPower = msg.compressorpower as number;
    if (msg.fanpower !== undefined) this.lastData.fanPower = msg.fanpower as number;
    if (msg.totalunitpower !== undefined) this.lastData.totalPower = msg.totalunitpower as number;

    // Humidity
    const humidity = msg[isIZ2 ? "iz2_humidity" : "humidity"] as number | undefined;

    if (isIZ2) {
      for (let z = 1; z <= this.numZones; z++) {
        const activeSettings = msg[`iz2_z${z}_activesettings`] as Record<string, unknown> | undefined;
        if (!activeSettings) continue;

        const zone: ZoneData = {
          currentTemp: (msg[`iz2_z${z}_roomtemp`] as number) ?? 0,
          heatingSetpoint: (activeSettings[`iz2_z${z}_heatingsp_read`] as number) ?? 70,
          coolingSetpoint: (activeSettings[`iz2_z${z}_coolingsp_read`] as number) ?? 75,
          activeMode: (activeSettings[`iz2_z${z}_activemode`] as number) ?? 1,
          fanMode: (activeSettings[`iz2_z${z}_fanmode_read`] as number) ?? 0,
          humidity: humidity ?? 0,
        };

        this.lastData.zones.set(z, zone);
      }
    } else {
      const activeSettings = msg.activesettings as Record<string, unknown> | undefined;
      const zone: ZoneData = {
        currentTemp: (msg.tstatroomtemp as number) ?? (msg.roomtemp as number) ?? 0,
        heatingSetpoint: (msg.tstatheatingsetpoint as number) ?? (activeSettings?.heatingsp_read as number) ?? 70,
        coolingSetpoint: (msg.tstatcoolingsetpoint as number) ?? (activeSettings?.coolingsp_read as number) ?? 75,
        activeMode: (activeSettings?.activemode as number) ?? 1,
        fanMode: (activeSettings?.fanmode_read as number) ?? 0,
        humidity: humidity ?? 0,
      };
      this.lastData.zones.set(1, zone);
    }
  }

  private readStatType(): void {
    this.sendCommand({
      cmd: "read",
      awlid: this.gwid,
      source: "tstat",
      zone: 0,
      rlist: ["AWLTStatType"],
    });
  }

  private readZoneCount(): void {
    this.sendCommand({
      cmd: "read",
      awlid: this.gwid,
      source: "tstat",
      zone: 0,
      rlist: ["iz2_max_zones"],
    });
  }

  private readAllZones(): void {
    const isIZ2 = this.numZones > 1;
    const rlist: string[] = [
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
    } else {
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

  private writeValue(register: string, value: number): void {
    if (!this.connected) {
      throw new Error("Not connected to Symphony");
    }

    const cmd: Record<string, unknown> = {
      cmd: "write",
      awlid: this.gwid,
      source: "tstat",
      [register]: value,
    };

    this.sendCommand(cmd);
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit("log", "Cannot send command: WebSocket not open");
      return;
    }

    this.tid = (this.tid + 1) % 100;
    cmd.tid = this.tid;

    this.ws.send(JSON.stringify(cmd));
  }

  private startPolling(): void {
    this.stopPolling();
    // Read immediately
    this.readAllZones();
    // Then poll every READ_INTERVAL_MS
    this.readTimer = setInterval(() => this.readAllZones(), READ_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.emit("log", "Scheduling reconnect in 30 seconds");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.emit("log", "Reconnected successfully");
      } catch (e) {
        this.emit("log", `Reconnect failed: ${e}`);
        this.scheduleReconnect();
      }
    }, 30_000);
  }
}
