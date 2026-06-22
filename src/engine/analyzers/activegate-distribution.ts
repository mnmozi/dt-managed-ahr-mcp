import type { EngineClient } from "../engine-client.js";

/** Typed wrapper for the engine's `activegate.distribution` analyzer. */

export interface ActiveGateDistributionInput {
  activeGates: ActiveGateRaw[];
  latestVersionsByOs: Record<string, string>;
}

export interface ActiveGateRaw {
  id?: string;
  hostname?: string;
  networkAddresses?: string[];
  loadBalancerAddresses?: string[];
  osType?: string;
  version?: string;
  type?: string;
  autoUpdateSettings?: { effectiveSetting?: string };
  autoUpdateStatus?: string;
  connectionStatus?: string;
  lastConnectedTime?: string;
  modules?: Array<{ type?: string; enabled?: boolean; misconfigured?: boolean; version?: string }>;
  enabledModules?: string[];
  networkZone?: string;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ActiveGateDistribution {
  totalActiveGates: number;
  latestVersionsByOs: Record<string, string>;
  versions: Record<string, number>;
  types: Record<string, number>;
  autoUpdateSettings: Record<string, number>;
  connectionStatuses: Record<string, number>;
  osTypes: Record<string, number>;
  notConnectedCount: number;
  misconfiguredModuleCount: number;
  byCapability: Record<string, number>;
  activeGatesByCapability: Record<string, AGRow[]>;
  misconfiguredByCapability: Record<string, AGRow[]>;
  networkZones: Record<string, number>;
  activeGatesByNetworkZone: Record<string, AGRow[]>;
  activeGatesWithoutNetworkZone: AGRow[] | null;
  activeGatesByType: Record<string, AGRow[]>;
  outdatedActiveGatesCount: number;
  outdatedActiveGatesSample: AGRow[] | null;
  activeGatesWithoutOsLatestReference: AGRow[] | null;
}

export interface AGRow {
  id?: string;
  hostname?: string;
  networkAddresses?: string[];
  osType?: string;
  version?: string;
  latestForOs?: string;
  minorBehind: number;
  type?: string;
  autoUpdateSetting?: string;
  connectionStatus?: string;
  networkZone?: string;
  enabledModules?: string[];
  misconfiguredModules?: string[];
  lastConnectedTime?: string;
}

export async function analyzeActiveGateDistribution(
  engine: EngineClient,
  input: ActiveGateDistributionInput
): Promise<ActiveGateDistribution> {
  return engine.analyze<ActiveGateDistribution>("activegate.distribution", input);
}
