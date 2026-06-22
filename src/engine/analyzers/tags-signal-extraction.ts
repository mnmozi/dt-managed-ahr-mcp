/** Typed wrapper for the engine's `tags.signal_extraction` analyzer. */
import type { EngineClient } from "../engine-client.js";
import type { TagGraphInput } from "../tag-graph-fetcher.js";

export interface TagSignalExtractionInput extends TagGraphInput {
  entitiesToProcess?: { id: string }[];
  targetKeys: string[];
  existingTagValues?: Record<string, string[]>;
  ownershipTeams?: string[];
  callGraphMajorityThreshold?: number;
  consensusMinConfidence?: number;
  consensusMinSources?: number;
}

export interface TagSignalExtractionResult {
  entities: EntityExtraction[];
  summary: ExtractionSummary;
  appliedDefaults: ExtractionAppliedDefaults;
}

export interface EntityExtraction {
  entityId: string;
  type: string;
  displayName?: string;
  candidates: Record<string, Candidate[]>;
  consensus?: Record<string, ConsensusValue>;
}

export interface Candidate {
  source: string;
  value: string;
  confidence: number;
  factors?: string[];
  evidence?: string;
}

export interface ConsensusValue {
  value: string;
  confidence: number;
  sourceCount: number;
  contributingSources: string[];
}

export interface ExtractionSummary {
  processedEntities: number;
  entitiesWithCandidates: number;
  entitiesWithConsensus: number;
  entitiesWithNoCandidates: number;
  consensusCountByKey: Record<string, number>;
}

export interface ExtractionAppliedDefaults {
  callGraphMajorityThreshold: number;
  consensusMinConfidence: number;
  consensusMinSources: number;
  targetKeys: string[];
}

export async function analyzeTagSignals(
  engine: EngineClient,
  input: TagSignalExtractionInput
): Promise<TagSignalExtractionResult> {
  return engine.analyze<TagSignalExtractionResult>("tags.signal_extraction", input);
}
