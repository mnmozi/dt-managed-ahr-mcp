/**
 * Typed wrapper for the engine's `services.naming_audit` analyzer.
 *
 * Output shape mirrors ServicesOutput in
 * internal/analyze/naming/services.go — keep in sync if you change one
 * side. Per-entity report shape is the same EntityNamingReport used by
 * the PG and host analyzers (same lattice, same response handling).
 */
import type { EngineClient } from "../engine-client.js";
import type { NamingGraphInput } from "../naming-graph-fetcher.js";
import type { EntityNamingReport } from "./processgroups-naming-audit.js";

export interface ServiceNamingAuditInput extends NamingGraphInput {
  /** How many candidates to surface per entity (engine default 5). */
  maxCandidates?: number;
  /** Attach rejectedCandidates (with written reasons) to every report. */
  explain?: boolean;
  /** Report EVERY entity (advisory candidates for healthy names too). */
  auditAll?: boolean;
}

export interface ServiceNamingCounts {
  totalServices: number;
  generic: number;
  highConfidence: number;
  ambiguous: number;
  noSignal: number;
}

export interface ServiceNamingAuditOutput {
  reports: EntityNamingReport[];
  counts: ServiceNamingCounts;
  appliedDefaults: {
    highConfidenceMin: number;
    highConfidenceGap: number;
    ambiguousMin: number;
    maxCandidates: number;
  };
}

export async function analyzeServiceNaming(
  engine: EngineClient,
  input: ServiceNamingAuditInput
): Promise<ServiceNamingAuditOutput> {
  return engine.analyze<ServiceNamingAuditOutput>("services.naming_audit", input);
}
