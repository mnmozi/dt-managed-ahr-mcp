/**
 * Typed wrapper for the engine's `hostgroups.coverage_audit` analyzer.
 *
 * Output shape mirrors HostGroupsOutput in
 * internal/analyze/naming/hostgroups.go — keep in sync if you change one
 * side. Five finding categories per the design.
 *
 * The companion MCP tool dt_export_hostgroup_remediation consumes this
 * output (plus the operator's `accept[]` picks) to emit oneagentctl
 * shell commands — host-group membership can't be changed via Dynatrace
 * API, so the remediation is a generated text artifact.
 */
import type { EngineClient } from "../engine-client.js";
import type { NamingGraphInput } from "../naming-graph-fetcher.js";

export interface HostGroupsCoverageAuditInput extends NamingGraphInput {
  /** Smallest fleet (same fleetKey) reported as "split". Engine default 2. */
  minFleetSize?: number;
  /** Levenshtein threshold for the typo detector. Engine default 2. */
  maxEditDistance?: number;
}

export interface HostWithoutGroup {
  hostId: string;
  displayName?: string;
  fleetSuggestion?: string;
  evidence?: string;
}

export interface HostReassign {
  hostId: string;
  displayName?: string;
  currentGroup?: string;
  newGroup: string;
  reason: string;
}

export interface SplitFleet {
  fleetKey: string;
  memberCount: number;
  currentDistribution: Record<string, number>;
  suggestedGroup?: string;
  hostsToReassign: HostReassign[];
}

export interface LikelyTypoGroup {
  groupName: string;
  memberCount: number;
  nearestPopulatedGroup: string;
  nearestMemberCount: number;
  editDistance: number;
}

export interface GenericGroup {
  groupName: string;
  memberCount: number;
  reason: string;
}

export interface NamingDriftCluster {
  normalized: string;
  variants: string[];
  totalMembers: number;
  perVariantCounts: Record<string, number>;
}

export interface HostGroupsCounts {
  totalHosts: number;
  totalHostGroups: number;
  hostsWithoutGroup: number;
  splitFleets: number;
  singleMemberLikelyTypos: number;
  genericGroupNames: number;
  namingDriftClusters: number;
}

export interface HostGroupsCoverageAuditOutput {
  hostsWithoutGroup: HostWithoutGroup[];
  splitFleets: SplitFleet[];
  singleMemberLikelyTypos: LikelyTypoGroup[];
  genericGroupNames: GenericGroup[];
  namingDrift: NamingDriftCluster[];
  counts: HostGroupsCounts;
  appliedDefaults: {
    minFleetSize: number;
    maxEditDistance: number;
  };
}

export async function analyzeHostGroupsCoverage(
  engine: EngineClient,
  input: HostGroupsCoverageAuditInput
): Promise<HostGroupsCoverageAuditOutput> {
  return engine.analyze<HostGroupsCoverageAuditOutput>(
    "hostgroups.coverage_audit",
    input
  );
}
