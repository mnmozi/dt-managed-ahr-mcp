import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * Walk a Config v1 dashboard payload and collect every metric reference we
 * can find. Reference shapes we handle:
 *
 *   1. Data Explorer tile (new):
 *        tile.queries[].metric = "builtin:service.requestCount.total"
 *        tile.queries[].metricSelector = "builtin:service.requestCount.total:splitBy(...)"
 *
 *   2. Data Explorer tile (older):
 *        tile.filterConfig.chartConfig.series[].metric
 *
 *   3. Custom-charting tile:
 *        tile.customChartingItems[].metricExpression
 *
 *   4. Markdown/header/note tiles: no metrics — skipped.
 *
 * Defensive: unknown shapes are ignored rather than throwing.
 */
export function extractMetricReferences(dashboard: unknown): Set<string> {
  const out = new Set<string>();
  if (!isObject(dashboard)) return out;
  const tiles = (dashboard as { tiles?: unknown }).tiles;
  if (!Array.isArray(tiles)) return out;

  for (const tile of tiles) {
    if (!isObject(tile)) continue;

    // (1) Data Explorer: tile.queries[]
    const queries = (tile as { queries?: unknown }).queries;
    if (Array.isArray(queries)) {
      for (const q of queries) {
        if (!isObject(q)) continue;
        const metric = (q as { metric?: unknown }).metric;
        if (typeof metric === "string" && metric.length > 0) {
          out.add(metric);
        }
        const selector = (q as { metricSelector?: unknown }).metricSelector;
        if (typeof selector === "string" && selector.length > 0) {
          const key = baseMetricKeyOfSelector(selector);
          if (key) out.add(key);
        }
      }
    }

    // (2) older filterConfig.chartConfig.series[].metric
    const filterCfg = (tile as { filterConfig?: unknown }).filterConfig;
    if (isObject(filterCfg)) {
      const chartCfg = (filterCfg as { chartConfig?: unknown }).chartConfig;
      if (isObject(chartCfg)) {
        const series = (chartCfg as { series?: unknown }).series;
        if (Array.isArray(series)) {
          for (const s of series) {
            if (!isObject(s)) continue;
            const metric = (s as { metric?: unknown }).metric;
            if (typeof metric === "string" && metric.length > 0) {
              out.add(metric);
            }
          }
        }
      }
    }

    // (3) custom-charting tile
    const items = (tile as { customChartingItems?: unknown }).customChartingItems;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (!isObject(it)) continue;
        const expr = (it as { metricExpression?: unknown }).metricExpression;
        if (typeof expr === "string" && expr.length > 0) {
          const key = baseMetricKeyOfSelector(expr);
          if (key) out.add(key);
        }
      }
    }
  }

  return out;
}

/**
 * Walk a Config v1 dashboard payload and collect every management-zone id it
 * references. Shapes we handle:
 *
 *   dashboard.dashboardMetadata.dashboardFilter.managementZone.id
 *   tile.tileFilter.managementZone.id           // per-tile override
 *   tile.filterConfig.filtersPerEntityType...   // less common, not handled
 *
 * Returns a Set of id strings (no name resolution — that's a separate check).
 */
export function extractManagementZoneIds(dashboard: unknown): Set<string> {
  const out = new Set<string>();
  if (!isObject(dashboard)) return out;

  const meta = (dashboard as { dashboardMetadata?: unknown }).dashboardMetadata;
  if (isObject(meta)) {
    const filter = (meta as { dashboardFilter?: unknown }).dashboardFilter;
    if (isObject(filter)) {
      const mz = (filter as { managementZone?: unknown }).managementZone;
      const id = isObject(mz) ? (mz as { id?: unknown }).id : undefined;
      if (typeof id === "string" && id.length > 0) out.add(id);
    }
  }

  const tiles = (dashboard as { tiles?: unknown }).tiles;
  if (Array.isArray(tiles)) {
    for (const tile of tiles) {
      if (!isObject(tile)) continue;
      const tileFilter = (tile as { tileFilter?: unknown }).tileFilter;
      if (isObject(tileFilter)) {
        const mz = (tileFilter as { managementZone?: unknown }).managementZone;
        const id = isObject(mz) ? (mz as { id?: unknown }).id : undefined;
        if (typeof id === "string" && id.length > 0) out.add(id);
      }
    }
  }

  return out;
}

/**
 * Pull the metric key prefix off a selector string. A selector is shaped
 *   <metric-key>(:<transform>)*
 * where a transform starts with a known function name followed by `(`.
 * Metric keys themselves can contain a single `:` (the namespace
 * separator, e.g. `builtin:`), so we can't just split on the first colon.
 *
 * Strategy: walk colon-separated segments; the metric key is the
 * longest leading run of segments that does NOT match the
 * `name(args...)` pattern. The first segment matching `\w+\(.*` ends
 * the key.
 */
export function baseMetricKeyOfSelector(selector: string): string | null {
  const segments = selector.split(":");
  const keyParts: string[] = [];
  for (const seg of segments) {
    if (/^[A-Za-z_]\w*\s*\(/.test(seg)) break; // a transform
    keyParts.push(seg);
  }
  const key = keyParts.join(":").trim();
  return key.length > 0 ? key : null;
}

export interface MetricValidationResult {
  ok: boolean;
  referenced: string[];
  exists: string[];
  /** Keys that came back 404 — these would have produced empty tiles. */
  missing: string[];
  /** For each missing key, up to 5 sibling keys we found via `<prefix>.*` lookup. */
  suggestions: Record<string, string[]>;
  /** Keys we couldn't confirm either way (HTTP errors other than 404). */
  unknown: Array<{ key: string; status: number; bodyPreview: string }>;
}

export interface ManagementZoneValidationResult {
  ok: boolean;
  referenced: string[];
  exists: Array<{ id: string; name: string }>;
  missing: string[];
  /** True if we couldn't fetch the MZ list at all — treat as inconclusive. */
  inconclusive: boolean;
  inconclusiveReason?: string;
}

export interface DashboardValidationResult {
  ok: boolean;
  metrics: MetricValidationResult;
  managementZones: ManagementZoneValidationResult;
}

export async function validateDashboardPayload(
  client: DtClient,
  dashboard: unknown
): Promise<DashboardValidationResult> {
  const [metrics, managementZones] = await Promise.all([
    validateDashboardMetrics(client, dashboard),
    validateDashboardManagementZones(client, dashboard),
  ]);
  return {
    ok: metrics.ok && managementZones.ok,
    metrics,
    managementZones,
  };
}

/**
 * For each unique metric key referenced in the dashboard, confirm it exists
 * on the tenant by GET /api/v2/metrics/{key}. On 404, also try `<prefix>.*`
 * to surface likely intended siblings as suggestions.
 */
export async function validateDashboardMetrics(
  client: DtClient,
  dashboard: unknown
): Promise<MetricValidationResult> {
  const referenced = Array.from(extractMetricReferences(dashboard));
  if (referenced.length === 0) {
    return { ok: true, referenced, exists: [], missing: [], suggestions: {}, unknown: [] };
  }

  const exists: string[] = [];
  const missing: string[] = [];
  const suggestions: Record<string, string[]> = {};
  const unknown: Array<{ key: string; status: number; bodyPreview: string }> = [];

  for (const key of referenced) {
    try {
      await client.get(`/api/v2/metrics/${encodeURIComponent(key)}`);
      exists.push(key);
    } catch (err) {
      if (err instanceof DtApiError) {
        if (err.status === 404) {
          missing.push(key);
          suggestions[key] = await suggestSiblings(client, key);
        } else {
          unknown.push({ key, status: err.status, bodyPreview: err.body.slice(0, 200) });
        }
      } else {
        unknown.push({
          key,
          status: 0,
          bodyPreview: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    ok: missing.length === 0 && unknown.length === 0,
    referenced,
    exists,
    missing,
    suggestions,
    unknown,
  };
}

/**
 * Try a couple of progressively-broader selectors to find sibling keys for a
 * missing one. E.g. for missing `builtin:service.requestCount`, try:
 *   builtin:service.requestCount.*   (likely just had a missing `.total`)
 *   builtin:service.*                 (broader; harder to interpret)
 * Returns up to 5 ids total.
 */
async function suggestSiblings(client: DtClient, missingKey: string): Promise<string[]> {
  const tries: string[] = [];
  // Strip last dotted segment and try as a glob
  const lastDot = missingKey.lastIndexOf(".");
  if (lastDot > 0) tries.push(missingKey.slice(0, lastDot) + ".*");
  tries.push(missingKey + ".*");
  const secondLastDot = missingKey.lastIndexOf(".", lastDot - 1);
  if (secondLastDot > 0) tries.push(missingKey.slice(0, secondLastDot) + ".*");

  const seen = new Set<string>();
  const out: string[] = [];
  for (const selector of tries) {
    if (out.length >= 5) break;
    try {
      const resp = await client.get<{ metrics?: Array<{ metricId: string }> }>("/api/v2/metrics", {
        query: { metricSelector: selector, pageSize: 10, fields: "metricId" },
      });
      for (const m of resp.metrics ?? []) {
        if (!seen.has(m.metricId)) {
          seen.add(m.metricId);
          out.push(m.metricId);
          if (out.length >= 5) break;
        }
      }
    } catch {
      // selector might be invalid — try the next one
    }
  }
  return out;
}

/**
 * For each unique MZ id referenced in the dashboard, confirm it exists by
 * looking it up in the full MZ list. Single list fetch — cheap.
 */
export async function validateDashboardManagementZones(
  client: DtClient,
  dashboard: unknown
): Promise<ManagementZoneValidationResult> {
  const referenced = Array.from(extractManagementZoneIds(dashboard));
  if (referenced.length === 0) {
    return { ok: true, referenced, exists: [], missing: [], inconclusive: false };
  }
  try {
    const resp = await client.get<{ values?: Array<{ id: string; name: string }> }>(
      "/api/config/v1/managementZones"
    );
    const byId = new Map<string, string>();
    for (const v of resp.values ?? []) byId.set(v.id, v.name);
    const exists: Array<{ id: string; name: string }> = [];
    const missing: string[] = [];
    for (const id of referenced) {
      const name = byId.get(id);
      if (name !== undefined) exists.push({ id, name });
      else missing.push(id);
    }
    return {
      ok: missing.length === 0,
      referenced,
      exists,
      missing,
      inconclusive: false,
    };
  } catch (err) {
    return {
      ok: false, // don't write a dashboard we couldn't pre-check
      referenced,
      exists: [],
      missing: [],
      inconclusive: true,
      inconclusiveReason:
        err instanceof DtApiError
          ? `MZ list fetch failed: HTTP ${err.status} ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
