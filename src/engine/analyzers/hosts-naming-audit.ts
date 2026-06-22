/**
 * Typed wrapper for the engine's `hosts.naming_audit` analyzer.
 *
 * Output shape mirrors HostsOutput in internal/analyze/naming/hosts.go —
 * keep in sync if you change one side. Per-entity report shape is the
 * same EntityNamingReport used by the PG analyzer (intentional — same
 * lattice, same response handling).
 */
import type { EngineClient } from "../engine-client.js";
import type { NamingGraphInput } from "../naming-graph-fetcher.js";
import type { EntityNamingReport } from "./processgroups-naming-audit.js";

export interface HostNamingAuditInput extends NamingGraphInput {
  /** How many candidates to surface per entity (engine default 5). */
  maxCandidates?: number;
}

export interface HostNamingCounts {
  totalHosts: number;
  generic: number;
  highConfidence: number;
  ambiguous: number;
  noSignal: number;
}

export interface HostNamingAuditOutput {
  reports: EntityNamingReport[];
  counts: HostNamingCounts;
  appliedDefaults: {
    highConfidenceMin: number;
    highConfidenceGap: number;
    ambiguousMin: number;
    maxCandidates: number;
  };
}

export async function analyzeHostNaming(
  engine: EngineClient,
  input: HostNamingAuditInput
): Promise<HostNamingAuditOutput> {
  return engine.analyze<HostNamingAuditOutput>("hosts.naming_audit", input);
}
