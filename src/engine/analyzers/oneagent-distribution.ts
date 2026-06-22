/**
 * Typed wrapper for the engine's `oneagent.distribution` analyzer.
 *
 * The engine MCP exposes a generic `engine_analyze({kind, input})` dispatcher;
 * this file is the TS-side typed shim. Each analyzer the MCP consumes gets
 * one of these files. Keep types here in sync with the Go `Output` struct
 * (per CONTRACT.md — there's no automatic codegen yet).
 */
import type { EngineClient } from "../engine-client.js";

export interface OneAgentDistributionInput {
  hosts: OneAgentHostRaw[];
  latestVersionsByOs: Record<string, string>;
}

/** Subset of the /api/v2/oneagents response shape the analyzer reads. */
export interface OneAgentHostRaw {
  hostInfo?: { hostName?: string; entityId?: string; osType?: string };
  currentVersion?: string;
  installerVersion?: string;
  autoUpdateSetting?: string;
  monitoringType?: string;
  faultyVersion?: boolean;
  active?: boolean;
  [k: string]: unknown;
}

export interface OneAgentDistribution {
  totalHosts: number;
  latestVersionsByOs: Record<string, string>;
  versions: Record<string, number>;
  autoUpdateSettings: Record<string, number>;
  monitoringTypes: Record<string, number>;
  osTypes: Record<string, number>;
  faultyVersionCount: number;
  inactiveCount: number;
  hostsByMonitoringType: Record<string, HostRow[]>;
  outdatedHostsCount: number;
  outdatedHostsSample: HostRow[] | null;
  hostsWithoutOsLatestReference: HostRow[] | null;
}

export interface HostRow {
  hostName?: string;
  entityId?: string;
  osType?: string;
  version?: string;
  latestForOs?: string;
  minorBehind: number;
  autoUpdateSetting?: string;
  faultyVersion: boolean;
  active: boolean;
}

export async function analyzeOneAgentDistribution(
  engine: EngineClient,
  input: OneAgentDistributionInput
): Promise<OneAgentDistribution> {
  return engine.analyze<OneAgentDistribution>("oneagent.distribution", input);
}
