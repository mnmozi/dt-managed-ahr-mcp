/** Typed wrapper for the engine's `tags.strategy_coverage` analyzer. */
import type { EngineClient } from "../engine-client.js";
import type { TagGraphInput } from "../tag-graph-fetcher.js";

export interface TagStrategyCoverageInput extends TagGraphInput {
  strategy: Record<string, KeyStrategy>;
  scopeEntityTypes?: string[];
}

export interface KeyStrategy {
  /**
   * Source spec list (first match wins). Examples:
   *   "property:hostGroupName"
   *   "awsTag:Team"
   *   "envVar:OWNING_TEAM"
   *   "containmentParent:tag:team"
   *   "callGraphMajority:tag:team"
   *   "siblingTag:team"
   *   "hostName.token[1]"
   *   "fallback:default-value"
   */
  extractFrom: string[];
  /** Implicit fallback if no source produces. */
  fallback?: string;
}

export interface TagStrategyCoverage {
  coveragePerKey: Record<string, KeyCoverage>;
  uncoveredEntities: UncoveredEntity[];
  achievableCoverage: number;
  appliedDefaults: { scopeEntityTypes: string[] };
}

export interface KeyCoverage {
  perType: Record<string, TypeCoverage>;
  overall: TypeCoverage;
}

export interface TypeCoverage {
  covered: number;
  uncovered: number;
  coverage: number;
}

export interface UncoveredEntity {
  entityId: string;
  type: string;
  displayName?: string;
  missingKeys: { key: string; sourcesTried: string[] }[];
}

export async function analyzeTagStrategyCoverage(
  engine: EngineClient,
  input: TagStrategyCoverageInput
): Promise<TagStrategyCoverage> {
  return engine.analyze<TagStrategyCoverage>("tags.strategy_coverage", input);
}
