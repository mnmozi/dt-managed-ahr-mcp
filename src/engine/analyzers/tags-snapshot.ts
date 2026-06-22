/** Typed wrapper for the engine's `tags.snapshot` analyzer. */
import type { EngineClient } from "../engine-client.js";
import type { TagGraphInput } from "../tag-graph-fetcher.js";

export interface TagSnapshotInput extends TagGraphInput {
  autoTagRules?: AutoTagRule[];
  lowTagThreshold?: number;
  graphMode?: "low_tag_only" | "full" | "none";
}

export interface AutoTagRule {
  objectId: string;
  value: { name: string };
}

export interface TagSnapshot {
  entitiesByType: Record<string, EntityTypeStats>;
  keys: KeyStats[];
  keySimilarityClusters: SimilarityCluster[];
  lowTagEntities: Record<string, LowTagEntity[]>;
  lowTagSubgraph?: { nodes: SubgraphNode[] };
  propagationHints: PropagationHint[];
  appliedDefaults: { lowTagThreshold: number; graphMode: string };
}

export interface EntityTypeStats { total: number; withZeroTags: number; withLowTags: number }
export interface KeyStats {
  key: string;
  totalOccurrences: number;
  coverage: Record<string, number>;
  distinctValues: string[];
  topValues: { value: string; count: number }[];
  valueFormatJudgment: "single" | "uniform" | "messy";
  valueFormatIssues?: { type: string; groups: string[][] }[];
  contextDistribution: Record<string, number>;
  sourcingRuleIds?: string[];
}
export interface SimilarityCluster {
  canonical: string;
  variants: string[];
  evidence: { pair: [string, string]; metric: string; score?: number; ratio?: number }[];
  totalOccurrences: number;
}
export interface LowTagEntity { entityId: string; displayName?: string; tagCount: number }
export interface SubgraphNode {
  entityId: string;
  type: string;
  displayName?: string;
  tagCount: number;
  tags?: { context?: string; key: string; value?: string }[];
  containmentParentIds?: string[];
  containmentChildrenIds?: string[];
  callsFromIds?: string[];
  callsToIds?: string[];
  parentTagDistribution?: Record<string, Record<string, number>>;
  siblingTagDistribution?: Record<string, Record<string, number>>;
  neighborTagDistribution?: Record<string, Record<string, number>>;
}
export interface PropagationHint {
  key: string;
  fullyCoveredOn: string[];
  partiallyCoveredOn: string[];
  uncoveredOn: string[];
  callGraphHint?: string;
}

export async function analyzeTagSnapshot(engine: EngineClient, input: TagSnapshotInput): Promise<TagSnapshot> {
  return engine.analyze<TagSnapshot>("tags.snapshot", input);
}
