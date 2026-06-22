/**
 * Typed wrapper for the engine's `processgroups.naming_audit` analyzer.
 *
 * Output shape mirrors the engine's Output struct in
 * internal/analyze/naming/processgroups.go — keep these in sync if you
 * change one side.
 */
import type { EngineClient } from "../engine-client.js";
import type { NamingGraphInput } from "../naming-graph-fetcher.js";

export interface ProcessGroupNamingAuditInput extends NamingGraphInput {
  /** How many candidates to surface per entity (engine default 5). */
  maxCandidates?: number;
}

export interface NamingCandidate {
  source: string;
  name: string;
  confidence: number;
  evidence: string;
}

export type NamingDecision = "high_confidence" | "ambiguous" | "no_signal";

export interface EntityNamingReport {
  entityId: string;
  entityType: string;
  currentName: string;
  genericReason: string;
  candidates: NamingCandidate[];
  topCandidate?: string;
  decision: NamingDecision;
}

export interface ProcessGroupNamingCounts {
  totalProcessGroups: number;
  generic: number;
  highConfidence: number;
  ambiguous: number;
  noSignal: number;
}

export interface ProcessGroupNamingAuditOutput {
  reports: EntityNamingReport[];
  counts: ProcessGroupNamingCounts;
  appliedDefaults: {
    highConfidenceMin: number;
    highConfidenceGap: number;
    ambiguousMin: number;
    maxCandidates: number;
  };
}

export async function analyzeProcessGroupNaming(
  engine: EngineClient,
  input: ProcessGroupNamingAuditInput
): Promise<ProcessGroupNamingAuditOutput> {
  return engine.analyze<ProcessGroupNamingAuditOutput>(
    "processgroups.naming_audit",
    input
  );
}
