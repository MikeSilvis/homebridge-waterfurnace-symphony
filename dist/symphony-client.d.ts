import { EventEmitter } from "events";
export interface ZoneData {
    currentTemp: number;
    heatingSetpoint: number;
    coolingSetpoint: number;
    activeMode: number;
    fanMode: number;
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
export declare const MODE: {
    readonly OFF: 0;
    readonly AUTO: 1;
    readonly COOL: 2;
    readonly HEAT: 3;
    readonly EHEAT: 4;
};
export declare const MODE_OF_OPERATION: {
    readonly STANDBY: 0;
    readonly FAN_ONLY: 1;
    readonly COOLING_1: 2;
    readonly COOLING_2: 3;
    readonly REHEAT: 4;
    readonly HEATING_1: 5;
    readonly HEATING_2: 6;
    readonly EHEAT: 7;
    readonly AUX_HEAT: 8;
    readonly LOCKOUT: 9;
};
export declare class SymphonyClient extends EventEmitter {
    private user;
    private password;
    private sessionId;
    private ws;
    private tid;
    private gwid;
    private numZones;
    private readTimer;
    private reconnectTimer;
    private connected;
    private lastData;
    constructor(user: string, password: string);
    get gatewayId(): string | null;
    get zoneCount(): number;
    get currentData(): SystemData;
    connect(): Promise<void>;
    disconnect(): void;
    setHeatingSetpoint(zone: number, temp: number): Promise<void>;
    setCoolingSetpoint(zone: number, temp: number): Promise<void>;
    setMode(zone: number, mode: number): Promise<void>;
    setFanMode(zone: number, fanMode: number): Promise<void>;
    setHumiditySetpoint(value: number): Promise<void>;
    private httpLogin;
    private connectWebSocket;
    private wsLogin;
    private handleMessage;
    private handleReadResponse;
    private parseZoneData;
    private readStatType;
    private readZoneCount;
    private readAllZones;
    private writeValue;
    private sendCommand;
    private startPolling;
    private stopPolling;
    private scheduleReconnect;
}
