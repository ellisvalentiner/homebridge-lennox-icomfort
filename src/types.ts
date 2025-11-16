/**
 * Type definitions for Lennox iComfort API responses
 */

export interface LennoxSystem {
  id: number;
  extId: string;
  name: string | null;
  status: SystemStatus;
}

export interface SystemStatus {
  relay_id: string;
  guid: string;
  arr: boolean;
  active: boolean;
  alive: boolean;
  substatuses: SubStatus[];
}

export interface SubStatus {
  relay_id: string;
  guid: string;
  dds_guid: string;
  active: boolean;
  active_ts: {
    sec: number;
    nanosec: number;
  };
  alive: boolean;
  alive_ts: {
    sec: number;
    nanosec: number;
  };
  user_data: string; // JSON string
}

export interface UserData {
  arr: boolean;
  csp: string;
  cspC: string;
  dband: number;
  dispUnits: 'F' | 'C';
  feelsLike: string;
  home: string;
  hsp: string;
  hspC: string;
  id: string;
  kind: string;
  maxCsp: number;
  maxCspC: string;
  maxHsp: number;
  maxHspC: string;
  minCsp: number;
  minCspC: string;
  minHsp: number;
  minHspC: string;
  numZones: number;
  occ: string;
  opMode: 'hc' | 'heat' | 'cool' | 'off';
  ot: number;
  otC: string;
  prdctType: string;
  rh: string;
  rsbusMode: string;
  schedNames: string;
  ssp: number;
  sspC: string;
  sspMode: string;
  status: 'h' | 'c' | 'off';
  sysName: string;
  tstamp: string;
  version: string;
  wsp: string;
  zit: string;
  zitC: string;
  zoneNames: string;
  zoningMode: string;
  fanMode?: 'auto' | 'on' | 'circulate';
}

export interface CertificateAuthResponse {
  serverAssigned: {
    identities: null;
    urls: null;
    security: {
      certificateToken: {
        type: string;
        issueTime: number;
        expiryTime: number;
        encoded: string;
        refreshToken: null;
      };
      lccToken: null;
      userToken: null;
      doNotPersist: boolean;
    };
  };
}

export interface LoginResponse {
  readyHomes: {
    homes: Home[];
  };
  ServerAssignedRoot: {
    serverAssigned: {
      security: {
        userToken: {
          type: string;
          issueTime: number;
          expiryTime: number;
          encoded: string;
          refreshToken: string;
        };
      };
    };
  };
}

export interface RegisterLCCOwnerResponse {
  token: string;
}

export interface Home {
  id: number;
  homeId: string;
  name: string;
  systems: SystemInfo[];
}

export interface SystemInfo {
  id: number;
  sysId: string;
  systemType: string;
}

export interface PublishCommandResponse {
  code: number;
  message: string;
  retry_after: number;
}

export interface SchedulePeriod {
  id: number;
  period: {
    desp?: number;
    hsp: number;
    cspC?: number;
    sp?: number;
    husp?: number;
    humidityMode?: string;
    systemMode: 'heat and cool' | 'heat' | 'cool' | 'off';
    spC?: number;
    hspC: number;
    csp: number;
    startTime: number;
    fanMode?: 'auto' | 'on' | 'circulate';
  };
}

export interface ScheduleCommand {
  schedules: Array<{
    schedule: {
      periods: SchedulePeriod[];
    };
    id: number;
  }>;
}

export interface ZoneHoldCommand {
  zones: Array<{
    config: {
      scheduleHold: {
        scheduleId: number;
        exceptionType: 'hold';
        enabled: boolean;
        expiresOn: string;
        expirationMode: 'nextPeriod' | 'timed' | 'manual';
      };
    };
    id: number;
  }>;
}

export interface PublishMessage {
  MessageType: 'Command';
  SenderID: string;
  MessageID: string;
  TargetID: string;
  Data: ScheduleCommand | ZoneHoldCommand;
}

export interface UserInfo {
  id: number;
  role: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  tel: string | null;
  auth: null;
  notifyAlertsToHomeowner: boolean;
  notifyRemindersToHomeowner: boolean;
  SubscribeMonthlyEmails: boolean;
}

export interface UserResponse {
  users: UserInfo[];
}
