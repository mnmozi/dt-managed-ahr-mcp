/**
 * Billing/consumption metrics are discovered, not hardcoded. Metric keys move
 * between Managed versions exactly like Settings schemas do — on 1.346
 * `builtin:billing.hostunits` and `builtin:billing.ddu.log` are gone and the
 * cluster advertises `builtin:billing.ddu.log.total`,
 * `builtin:billing.full_stack_monitoring.usage_per_host`, etc. A curated list
 * silently returns 'unavailable' for 7 of 9 categories; discovery returns
 * whatever the cluster actually meters.
 */
import type { DtClient } from "../dt-client.js";

interface MetricListResponse {
  nextPageKey?: string | null;
  metrics?: Array<{ metricId?: string; displayName?: string; unit?: string }>;
}

export interface DiscoveredMetric {
  metricId: string;
  displayName?: string;
  unit?: string;
}

/**
 * Keep environment-level usage/total series; drop per-entity / per-key
 * breakdowns (…byEntity, …usage_by_host, …byMetric) whose cardinality swamps
 * a summary without adding to the cost story.
 */
export function isAggregateBillingMetric(id: string): boolean {
  if (!id.startsWith("builtin:billing.")) return false;
  const low = id.toLowerCase();
  for (const breakdown of ["_by_", "byentity", "bymetric", "bydescription", "byapp"]) {
    if (low.includes(breakdown)) return false;
  }
  return /(\.usage|\.total|_per_host|_per_container|\.actions|\.external|\.requests|\.included|\.ingested)$/.test(
    id
  );
}

/** Second path segment after `builtin:billing.` — groups related meters. */
export function billingFamily(id: string): string {
  const rest = id.slice("builtin:billing.".length);
  return rest.split(".")[0] ?? rest;
}

/** List every metric the cluster advertises under a selector (paginated). */
export async function discoverMetrics(
  client: DtClient,
  metricSelector: string,
  maxPages = 20
): Promise<DiscoveredMetric[]> {
  const out: DiscoveredMetric[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const resp = nextPageKey
      ? await client.get<MetricListResponse>("/api/v2/metrics", { query: { nextPageKey } })
      : await client.get<MetricListResponse>("/api/v2/metrics", {
          query: { metricSelector, fields: "metricId,displayName,unit", pageSize: 500 },
        });
    for (const m of resp.metrics ?? []) {
      if (m.metricId) out.push({ metricId: m.metricId, displayName: m.displayName, unit: m.unit });
    }
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < maxPages);
  return out;
}
