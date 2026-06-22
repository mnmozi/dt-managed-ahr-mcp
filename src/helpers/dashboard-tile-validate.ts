/**
 * Dashboard tile-type validation.
 *
 * Dynatrace's Config v1 dashboards accept ANY `tileType` string — typos like
 * `DATA_EXPLORE` (missing R) silently render an empty tile. The caller gets
 * 201 Created and a perfectly broken dashboard.
 *
 * This validator runs alongside extractMetricReferences. For each tile it:
 *   - checks tileType is in the known allow-list
 *   - if unknown, suggests the closest match by Levenshtein distance
 *   - per known tileType, checks the small set of fields that are mandatory
 *     (e.g. DATA_EXPLORER needs queries; MARKDOWN needs markdown text)
 *
 * Unknown tile shapes are treated as warnings, not errors — Dynatrace adds
 * new tile types in every release and we'd rather be permissive than block.
 * Typos in known tile names ARE errors (high confidence the caller meant the
 * known name).
 */

export interface TileIssue {
  index: number;
  tileType: string;
  field?: string;
  message: string;
  severity: "error" | "warning";
}

export interface TileValidationResult {
  ok: boolean;
  issues: TileIssue[];
  /** Per-tile-type counts for diagnostics. */
  countsByType: Record<string, number>;
}

/**
 * Allow-list of Config v1 dashboard tile types and the field(s) each one
 * requires for non-empty rendering. Sourced from the Config v1 dashboards
 * schema and Data Explorer export samples. Extend as we observe more.
 *
 * `requiredOneOf` means at least one of the listed fields must be present
 * and non-empty for the tile to render.
 */
export const KNOWN_TILE_TYPES: Record<
  string,
  { requiredOneOf?: string[]; requiredAll?: string[]; note?: string }
> = {
  DATA_EXPLORER: {
    requiredOneOf: ["queries", "customChartingItems"],
    note: "Data Explorer tile — at least one of queries[] or customChartingItems[] is required",
  },
  CUSTOM_CHARTING: {
    requiredOneOf: ["filterConfig", "customChartingItems"],
  },
  MARKDOWN: {
    requiredAll: ["markdown"],
  },
  HEADER: {},
  HOSTS: {},
  APPLICATIONS: {},
  SERVICES: {},
  DATABASES_OVERVIEW: {},
  PROCESS_GROUPS_ONE: {},
  HOST: {},
  APPLICATION_WORLDMAP: {},
  RESOURCES: {},
  IMAGE: {
    requiredAll: ["assetId"],
  },
  AWS: {},
  USER_SESSION_QUERY: {
    requiredAll: ["query"],
    note: "USQL tile — query is required",
  },
  PURE_MODEL: {},
  SCALABLE_LIST: {},
  SLO: {},
  SYNTHETIC_SINGLE_WEBCHECK: {},
  SYNTHETIC_SINGLE_EXT_TEST: {},
  SYNTHETIC_HTTP_MONITOR: {},
  SYNTHETIC_TESTS: {},
  OPENAPI: {},
  THIRD_PARTY_TILE: {},
  UEM_CONVERSION_BY_GOALS: {},
  UEM_KEY_USER_ACTIONS: {},
  // Internal Dynatrace tile types — present in exports but rarely set by hand.
  DTAQL: {},
  TOPOLOGY: {},
};

/**
 * Compare two strings with Levenshtein distance. Used for "did you mean…"
 * suggestions on unknown tile types. Trivial implementation; tile types
 * are short so the O(n*m) cost is fine.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j]! + 1, // deletion
        dp[j - 1]! + 1, // insertion
        prev + cost // substitution
      );
      prev = tmp;
    }
  }
  return dp[n]!;
}

function suggestTileType(unknown: string): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const name of Object.keys(KNOWN_TILE_TYPES)) {
    const dist = levenshtein(unknown.toUpperCase(), name);
    if (best === null || dist < best.dist) best = { name, dist };
  }
  // Only suggest if the edit distance is small relative to the length.
  if (!best) return null;
  const tolerance = Math.max(1, Math.floor(best.name.length / 4));
  return best.dist <= tolerance ? best.name : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasNonEmptyField(tile: Record<string, unknown>, field: string): boolean {
  const v = tile[field];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function validateDashboardTiles(dashboard: unknown): TileValidationResult {
  const issues: TileIssue[] = [];
  const countsByType: Record<string, number> = {};

  if (!isObject(dashboard)) {
    return { ok: true, issues: [], countsByType };
  }
  const tiles = dashboard["tiles"];
  if (!Array.isArray(tiles)) {
    return { ok: true, issues: [], countsByType };
  }

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!isObject(tile)) {
      issues.push({
        index: i,
        tileType: "<not an object>",
        message: "tile is not a JSON object",
        severity: "error",
      });
      continue;
    }
    const tileType = tile["tileType"];
    if (typeof tileType !== "string" || tileType.length === 0) {
      issues.push({
        index: i,
        tileType: "<missing>",
        field: "tileType",
        message: "tileType is required (string)",
        severity: "error",
      });
      continue;
    }
    countsByType[tileType] = (countsByType[tileType] ?? 0) + 1;

    const spec = KNOWN_TILE_TYPES[tileType];
    if (!spec) {
      const suggestion = suggestTileType(tileType);
      if (suggestion) {
        issues.push({
          index: i,
          tileType,
          field: "tileType",
          message: `unknown tileType '${tileType}' — did you mean '${suggestion}'? Typo'd tile types render empty silently.`,
          severity: "error",
        });
      } else {
        issues.push({
          index: i,
          tileType,
          field: "tileType",
          message: `unknown tileType '${tileType}' — not in the validator's allow-list. Verify the spelling against the Config v1 dashboards schema before posting.`,
          severity: "warning",
        });
      }
      continue;
    }

    if (spec.requiredAll) {
      for (const field of spec.requiredAll) {
        if (!hasNonEmptyField(tile, field)) {
          issues.push({
            index: i,
            tileType,
            field,
            message: `tileType '${tileType}' requires non-empty '${field}'${spec.note ? ` (${spec.note})` : ""}`,
            severity: "error",
          });
        }
      }
    }
    if (spec.requiredOneOf) {
      const anyPresent = spec.requiredOneOf.some((f) => hasNonEmptyField(tile, f));
      if (!anyPresent) {
        issues.push({
          index: i,
          tileType,
          field: spec.requiredOneOf.join("|"),
          message: `tileType '${tileType}' requires at least one of: ${spec.requiredOneOf.join(", ")}${spec.note ? ` (${spec.note})` : ""}`,
          severity: "error",
        });
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    countsByType,
  };
}
