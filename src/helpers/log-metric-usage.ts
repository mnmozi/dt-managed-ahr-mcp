import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * Log-metric usage audit: is every `log.*` metric produced by a log
 * metric-extraction rule actually read by something in the tenant?
 *
 * Consumers we can see:
 *   - metric events     builtin:anomaly-detection.metric-events  value.queryDefinition
 *   - SLOs              /api/v2/slo  metricExpression / metricNumerator / metricDenominator / metricRate
 *   - dashboards        /api/config/v1/dashboards/{id}  any metric string in a tile
 *
 * Consumers we cannot see (so "orphan" means "no in-tenant consumer", not
 * "unused"): external Metrics API readers (Grafana, scripts, reports),
 * ad-hoc Data Explorer sessions, and dashboards the token can't list.
 */

export const LOG_METRIC_SCHEMAS = [
  "builtin:logmonitoring.schemaless-log-metric",
  "builtin:logmonitoring.metric-extraction",
] as const;

const METRIC_EVENT_SCHEMA = "builtin:anomaly-detection.metric-events";

/** Tile fields that hold prose, not metric selectors — a key mentioned in a markdown note isn't a consumer. */
const DASHBOARD_PROSE_KEYS = new Set(["markdown", "name", "title", "description", "textContent"]);

const SLO_METRIC_FIELDS = ["metricExpression", "metricNumerator", "metricDenominator", "metricRate"] as const;

export type ConsumerType = "metric_event" | "slo" | "dashboard";

export interface Consumer {
  type: ConsumerType;
  id: string;
  name: string;
  /** Disabled metric events / SLOs are listed but don't count as active consumers. */
  enabled: boolean;
  /** The raw strings that referenced metrics; matched against each log metric key. */
  texts: string[];
}

export interface LogMetricRule {
  key: string;
  objectId: string;
  schemaId: string;
  enabled: boolean;
  /** Epoch ms, when the Settings API returned it. */
  created?: number;
}

export type DataStatus = "has_data" | "no_data" | "not_registered" | "unknown";

export type Bucket = "used" | "broken" | "orphan" | "dead" | "recent" | "inconclusive";

export interface LogMetricFinding {
  key: string;
  objectId: string;
  schemaId: string;
  enabled: boolean;
  created?: string;
  bucket: Bucket;
  reason: string;
  dataStatus: DataStatus;
  /** From the metric descriptor, only looked up for metrics without data in the window. "never" = registered but never written. */
  lastWritten?: string;
  activeConsumers: Array<{ type: ConsumerType; id: string; name: string }>;
  disabledConsumers: Array<{ type: ConsumerType; id: string; name: string }>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every string value under `node`, skipping properties named in `skipKeys`. */
export function collectStrings(node: unknown, skipKeys: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") {
      out.push(n);
    } else if (Array.isArray(n)) {
      n.forEach(walk);
    } else if (isObject(n)) {
      for (const [k, v] of Object.entries(n)) {
        if (!skipKeys.has(k)) walk(v);
      }
    }
  };
  walk(node);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `key` appears in `text` as a whole metric key. Expressions like
 * `(100)*(log.ok)/(log.total)` reference several keys, so this scans the
 * whole string rather than taking the selector's base key. The boundaries
 * stop `log.a` from matching `log.ab` or `log.a.b`; the comparison is
 * case-insensitive so a casing mismatch can't produce a false orphan.
 */
export function referencesKey(text: string, key: string): boolean {
  const re = new RegExp(`(?<![\\w.:-])${escapeRegExp(key)}(?![\\w.-])`, "i");
  return re.test(text);
}

/** Normalize a rule's key: the UI fixes the `log.` prefix, the API usually includes it. */
export function normalizeLogMetricKey(raw: string): string {
  const k = raw.trim();
  return k.toLowerCase().startsWith("log.") ? k : `log.${k}`;
}

export function classify(
  rule: LogMetricRule,
  consumers: Consumer[],
  dataStatus: DataStatus,
  opts: { now: number; graceDays: number }
): LogMetricFinding {
  const matching = consumers.filter((c) => c.texts.some((t) => referencesKey(t, rule.key)));
  const ref = (c: Consumer) => ({ type: c.type, id: c.id, name: c.name });
  const active = matching.filter((c) => c.enabled).map(ref);
  const disabled = matching.filter((c) => !c.enabled).map(ref);

  const hasData = dataStatus === "has_data";
  const noData = dataStatus === "no_data" || dataStatus === "not_registered";
  const isRecent =
    rule.created !== undefined && opts.now - rule.created < opts.graceDays * 86_400_000;

  let bucket: Bucket;
  let reason: string;
  if (active.length > 0) {
    if (noData || !rule.enabled) {
      bucket = "broken";
      reason = !rule.enabled
        ? "Extraction rule is disabled but consumers still read the metric — they see no data."
        : "Consumers read the metric but it has no data in the window — alerts/SLOs/tiles are silently empty. Check the rule's matcher and whether the log source still exists.";
    } else {
      bucket = "used";
      reason =
        dataStatus === "unknown"
          ? "Has consumers; data presence could not be verified."
          : "Has consumers and data.";
    }
  } else if (isRecent) {
    bucket = "recent";
    reason = `Created within the last ${opts.graceDays} days — too new to call unused.`;
  } else if (hasData) {
    bucket = "orphan";
    reason =
      "Produces data (DDU-metrics cost) but no metric event, SLO or dashboard reads it. Delete the rule, or wire the metric into an alert/SLO/tile if it was meant to be used. Confirm no external API consumer first.";
  } else if (noData) {
    bucket = "dead";
    reason = "No consumer and no data — safe to delete.";
  } else {
    bucket = "inconclusive";
    reason = "No consumer found; data presence could not be verified.";
  }
  if (disabled.length > 0 && active.length === 0) {
    reason += " Only referenced by disabled metric events/SLOs.";
  }

  return {
    key: rule.key,
    objectId: rule.objectId,
    schemaId: rule.schemaId,
    enabled: rule.enabled,
    created: rule.created !== undefined ? new Date(rule.created).toISOString() : undefined,
    bucket,
    reason,
    dataStatus,
    activeConsumers: active,
    disabledConsumers: disabled,
  };
}

// ---------- fetchers ----------

interface SettingsListResponse {
  nextPageKey?: string | null;
  items?: Array<{ objectId?: string; schemaId?: string; value?: unknown; created?: number }>;
}

/**
 * `created` drives the grace period, but older Managed versions may reject it
 * in `fields` with a 400 — retry without it rather than lose the whole list.
 */
async function listSettings(client: DtClient, schemaId: string): Promise<NonNullable<SettingsListResponse["items"]>> {
  try {
    return await listSettingsWithFields(client, schemaId, "objectId,schemaId,value,created");
  } catch (err) {
    if (err instanceof DtApiError && err.status === 400) {
      return listSettingsWithFields(client, schemaId, "objectId,schemaId,value");
    }
    throw err;
  }
}

async function listSettingsWithFields(
  client: DtClient,
  schemaId: string,
  fields: string
): Promise<NonNullable<SettingsListResponse["items"]>> {
  const all: NonNullable<SettingsListResponse["items"]> = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const resp = nextPageKey
      ? await client.get<SettingsListResponse>("/api/v2/settings/objects", { query: { nextPageKey } })
      : await client.get<SettingsListResponse>("/api/v2/settings/objects", {
          query: { schemaIds: schemaId, pageSize: 500, fields },
        });
    if (resp.items) all.push(...resp.items);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < 50);
  return all;
}

export interface SourceCoverage {
  ok: boolean;
  count: number;
  error?: string;
}

function errorText(err: unknown): string {
  if (err instanceof DtApiError) return `${err.status}: ${err.body.slice(0, 200)}`;
  return err instanceof Error ? err.message : String(err);
}

export async function fetchLogMetricRules(
  client: DtClient
): Promise<{ rules: LogMetricRule[]; coverage: Record<string, SourceCoverage> }> {
  const rules: LogMetricRule[] = [];
  const coverage: Record<string, SourceCoverage> = {};
  for (const schemaId of LOG_METRIC_SCHEMAS) {
    try {
      const items = await listSettings(client, schemaId);
      let count = 0;
      for (const it of items) {
        const v = isObject(it.value) ? it.value : {};
        const rawKey = typeof v.key === "string" ? v.key : typeof v.metricKey === "string" ? v.metricKey : undefined;
        if (!rawKey) continue;
        rules.push({
          key: normalizeLogMetricKey(rawKey),
          objectId: it.objectId ?? "?",
          schemaId,
          enabled: v.enabled !== false,
          created: typeof it.created === "number" ? it.created : undefined,
        });
        count++;
      }
      coverage[schemaId] = { ok: true, count };
    } catch (err) {
      coverage[schemaId] = { ok: false, count: 0, error: errorText(err) };
    }
  }
  return { rules, coverage };
}

export async function fetchMetricEventConsumers(client: DtClient): Promise<{ consumers: Consumer[]; coverage: SourceCoverage }> {
  try {
    const items = await listSettings(client, METRIC_EVENT_SCHEMA);
    const consumers = items.map((it): Consumer => {
      const v = isObject(it.value) ? it.value : {};
      return {
        type: "metric_event",
        id: it.objectId ?? "?",
        name: typeof v.summary === "string" ? v.summary : it.objectId ?? "?",
        enabled: v.enabled !== false,
        texts: collectStrings(v.queryDefinition),
      };
    });
    return { consumers, coverage: { ok: true, count: consumers.length } };
  } catch (err) {
    return { consumers: [], coverage: { ok: false, count: 0, error: errorText(err) } };
  }
}

interface SloListResponse {
  slo?: Array<Record<string, unknown>>;
  nextPageKey?: string | null;
}

export async function fetchSloConsumers(client: DtClient): Promise<{ consumers: Consumer[]; coverage: SourceCoverage }> {
  try {
    const consumers: Consumer[] = [];
    let nextPageKey: string | null | undefined;
    let pages = 0;
    do {
      const resp = nextPageKey
        ? await client.get<SloListResponse>("/api/v2/slo", { query: { nextPageKey } })
        : await client.get<SloListResponse>("/api/v2/slo", {
            query: { pageSize: 500, evaluate: "false", enabledSlos: "all" },
          });
      for (const s of resp.slo ?? []) {
        const texts = SLO_METRIC_FIELDS.map((f) => s[f]).filter((t): t is string => typeof t === "string");
        consumers.push({
          type: "slo",
          id: typeof s.id === "string" ? s.id : "?",
          name: typeof s.name === "string" ? s.name : "?",
          enabled: s.enabled !== false,
          texts,
        });
      }
      nextPageKey = resp.nextPageKey ?? null;
      pages++;
    } while (nextPageKey && pages < 50);
    return { consumers, coverage: { ok: true, count: consumers.length } };
  } catch (err) {
    return { consumers: [], coverage: { ok: false, count: 0, error: errorText(err) } };
  }
}

export interface DashboardCoverage extends SourceCoverage {
  listed: number;
  scanned: number;
  failed: Array<{ id: string; error: string }>;
  truncated: boolean;
}

export async function fetchDashboardConsumers(
  client: DtClient,
  opts: { maxDashboards: number; concurrency?: number }
): Promise<{ consumers: Consumer[]; coverage: DashboardCoverage }> {
  let list: Array<{ id?: string; name?: string }>;
  try {
    const resp = await client.get<{ dashboards?: Array<{ id?: string; name?: string }> }>("/api/config/v1/dashboards");
    list = resp.dashboards ?? [];
  } catch (err) {
    return {
      consumers: [],
      coverage: { ok: false, count: 0, listed: 0, scanned: 0, failed: [], truncated: false, error: errorText(err) },
    };
  }

  const toScan = list.filter((d) => d.id).slice(0, opts.maxDashboards);
  const consumers: Consumer[] = [];
  const failed: DashboardCoverage["failed"] = [];
  const concurrency = opts.concurrency ?? 5;
  for (let i = 0; i < toScan.length; i += concurrency) {
    await Promise.all(
      toScan.slice(i, i + concurrency).map(async (d) => {
        const id = d.id as string;
        try {
          const dash = await client.get<{ tiles?: unknown[] }>(`/api/config/v1/dashboards/${encodeURIComponent(id)}`);
          consumers.push({
            type: "dashboard",
            id,
            name: d.name ?? id,
            enabled: true,
            texts: collectStrings(dash.tiles ?? [], DASHBOARD_PROSE_KEYS),
          });
        } catch (err) {
          failed.push({ id, error: errorText(err) });
        }
      })
    );
  }
  return {
    consumers,
    coverage: {
      ok: failed.length === 0,
      count: consumers.length,
      listed: list.length,
      scanned: consumers.length,
      failed,
      truncated: list.length > toScan.length,
    },
  };
}

interface MetricQueryResponse {
  result?: Array<{ metricId?: string; data?: Array<{ values?: Array<number | null> }> }>;
}

function seriesHasData(r: NonNullable<MetricQueryResponse["result"]>[number] | undefined): boolean {
  return (r?.data ?? []).some((s) => (s.values ?? []).some((v) => typeof v === "number" && !Number.isNaN(v)));
}

/**
 * One value per metric over the window (`resolution=Inf`, `splitBy()`), 10
 * selectors per request. An unknown key 404s the whole request, so a failed
 * batch falls back to one query per key to isolate it.
 */
export async function fetchDataStatus(
  client: DtClient,
  keys: string[],
  window: { from: string; to: string }
): Promise<Map<string, DataStatus>> {
  const out = new Map<string, DataStatus>();
  const query = (selectorKeys: string[]) =>
    client.get<MetricQueryResponse>("/api/v2/metrics/query", {
      query: {
        metricSelector: selectorKeys.map((k) => `${k}:splitBy()`).join(","),
        from: window.from,
        to: window.to,
        resolution: "Inf",
      },
    });

  const unique = Array.from(new Set(keys));
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    try {
      const resp = await query(batch);
      const results = resp.result ?? [];
      batch.forEach((k, idx) => {
        const r = results.find((x) => x.metricId === `${k}:splitBy()`) ?? results[idx];
        out.set(k, seriesHasData(r) ? "has_data" : "no_data");
      });
    } catch {
      for (const k of batch) {
        try {
          const resp = await query([k]);
          out.set(k, seriesHasData(resp.result?.[0]) ? "has_data" : "no_data");
        } catch (err) {
          out.set(k, err instanceof DtApiError && err.status === 404 ? "not_registered" : "unknown");
        }
      }
    }
  }
  return out;
}

/**
 * For metrics without data in the window, the descriptor's `lastWritten`
 * says whether the metric stopped on a date (log source or matcher changed)
 * or never produced anything (matcher never matched). Best effort: a failed
 * lookup just leaves the field out.
 */
export async function fetchLastWritten(client: DtClient, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(keys));
  for (let i = 0; i < unique.length; i += 5) {
    await Promise.all(
      unique.slice(i, i + 5).map(async (k) => {
        try {
          const d = await client.get<{ lastWritten?: number | null }>(`/api/v2/metrics/${encodeURIComponent(k)}`);
          out.set(k, typeof d.lastWritten === "number" ? new Date(d.lastWritten).toISOString() : "never");
        } catch {
          // leave unset
        }
      })
    );
  }
  return out;
}

export interface LogMetricUsageReport {
  window: { from: string; to: string };
  graceDays: number;
  conclusive: boolean;
  warnings: string[];
  coverage: {
    rules: Record<string, SourceCoverage>;
    metricEvents: SourceCoverage;
    slos: SourceCoverage;
    dashboards: DashboardCoverage;
  };
  summary: Record<Bucket, number> & { total: number };
  findings: LogMetricFinding[];
  blindSpots: string[];
}

const BUCKET_ORDER: Bucket[] = ["broken", "orphan", "dead", "inconclusive", "recent", "used"];

export async function auditLogMetricUsage(
  client: DtClient,
  opts: { from: string; to: string; graceDays: number; maxDashboards: number; now?: number }
): Promise<LogMetricUsageReport> {
  const [ruleRes, meRes, sloRes, dashRes] = await Promise.all([
    fetchLogMetricRules(client),
    fetchMetricEventConsumers(client),
    fetchSloConsumers(client),
    fetchDashboardConsumers(client, { maxDashboards: opts.maxDashboards }),
  ]);
  const window = { from: opts.from, to: opts.to };
  const dataStatus = await fetchDataStatus(client, ruleRes.rules.map((r) => r.key), window);
  const lastWritten = await fetchLastWritten(
    client,
    ruleRes.rules.filter((r) => dataStatus.get(r.key) === "no_data").map((r) => r.key)
  );
  const consumers = [...meRes.consumers, ...sloRes.consumers, ...dashRes.consumers];
  const now = opts.now ?? Date.now();

  const findings = ruleRes.rules
    .map((r) => {
      const f = classify(r, consumers, dataStatus.get(r.key) ?? "unknown", { now, graceDays: opts.graceDays });
      const lw = lastWritten.get(r.key);
      return lw ? { ...f, lastWritten: lw } : f;
    })
    .sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) || a.key.localeCompare(b.key));

  const summary = { total: findings.length } as LogMetricUsageReport["summary"];
  for (const b of BUCKET_ORDER) summary[b] = findings.filter((f) => f.bucket === b).length;

  const warnings: string[] = [];
  if (!meRes.coverage.ok) warnings.push(`Metric events could not be read (${meRes.coverage.error}).`);
  if (!sloRes.coverage.ok) warnings.push(`SLOs could not be read (${sloRes.coverage.error}).`);
  if (dashRes.coverage.error) warnings.push(`Dashboards could not be listed (${dashRes.coverage.error}).`);
  if (dashRes.coverage.failed.length > 0) warnings.push(`${dashRes.coverage.failed.length} dashboard(s) could not be fetched.`);
  if (dashRes.coverage.truncated)
    warnings.push(`Only ${dashRes.coverage.scanned} of ${dashRes.coverage.listed} dashboards scanned (maxDashboards).`);
  if (!Object.values(ruleRes.coverage).some((c) => c.ok)) warnings.push("No log metric rule schema could be read.");
  const conclusive = warnings.length === 0;
  if (!conclusive) {
    warnings.push("Consumer coverage is incomplete — treat orphan/dead findings as candidates, not verdicts.");
  }

  return {
    window,
    graceDays: opts.graceDays,
    conclusive,
    warnings,
    coverage: { rules: ruleRes.coverage, metricEvents: meRes.coverage, slos: sloRes.coverage, dashboards: dashRes.coverage },
    summary,
    findings,
    blindSpots: [
      "External Metrics API readers (Grafana, scripts, exported reports) are invisible here — confirm with owners before deleting an orphan.",
      "Ad-hoc Data Explorer use is not persisted anywhere.",
      "Dashboards the token cannot list (private to other users) are not scanned; see coverage.dashboards.listed.",
    ],
  };
}
