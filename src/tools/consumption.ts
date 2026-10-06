import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("consumption");

interface MetricQueryResponse {
  totalCount?: number;
  resolution?: string;
  result?: Array<{
    metricId?: string;
    data?: Array<{
      dimensions?: string[];
      timestamps?: number[];
      values?: Array<number | null>;
    }>;
  }>;
}

interface CatalogEntry {
  metricId: string;
  displayName?: string;
  unit?: string;
  description?: string;
  dimensionDefinitions?: Array<{ key?: string }>;
}

interface CatalogResponse {
  metrics?: CatalogEntry[];
  nextPageKey?: string | null;
  totalCount?: number;
}

/**
 * Fallback probes, used only when catalog discovery itself fails (e.g. the
 * read token lacks metrics.read for /api/v2/metrics but still has it for
 * /api/v2/metrics/query — unusual, but cheap to cover). The exact billing
 * metric keys drift across Managed versions and license types, which is
 * exactly why discovery is the primary path.
 */
const FALLBACK_PROBES: string[] = [
  "builtin:billing.full_stack_monitoring.usage",
  "builtin:billing.full_stack_monitoring.usage_per_host",
  "builtin:billing.infrastructure_monitoring.usage",
  "builtin:billing.ddu.metrics.total",
  "builtin:billing.ddu.log.total",
  "builtin:billing.ddu.events.total",
  "builtin:billing.ddu.traces.total",
  "builtin:billing.ddu.serverless.total",
  "builtin:billing.synthetic.actions",
  "builtin:billing.usersession.user_session_count",
];

type Category =
  | "hostUnits"
  | "dduMetrics"
  | "dduLogs"
  | "dduEvents"
  | "dduTraces"
  | "dduServerless"
  | "synthetic"
  | "sessions"
  | "other";

/** Bucket a billing metric id into the AHR cost categories by its key shape. */
export function categorize(metricId: string): Category {
  const id = metricId.toLowerCase();
  if (id.includes("ddu.metrics")) return "dduMetrics";
  if (id.includes("ddu.log")) return "dduLogs";
  if (id.includes("ddu.events")) return "dduEvents";
  if (id.includes("ddu.traces")) return "dduTraces";
  if (id.includes("ddu.serverless")) return "dduServerless";
  if (id.includes("synthetic")) return "synthetic";
  if (id.includes("session")) return "sessions";
  if (id.includes("host") || id.includes("full_stack") || id.includes("infrastructure")) return "hostUnits";
  return "other";
}

function sumValues(resp: MetricQueryResponse): { total: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (const r of resp.result ?? []) {
    for (const d of r.data ?? []) {
      for (const v of d.values ?? []) {
        if (typeof v === "number" && !Number.isNaN(v)) {
          total += v;
          samples++;
        }
      }
    }
  }
  return { total, samples };
}

async function discoverBillingMetrics(client: DtClient): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const resp = nextPageKey
      ? await client.get<CatalogResponse>("/api/v2/metrics", { query: { nextPageKey } })
      : await client.get<CatalogResponse>("/api/v2/metrics", {
          query: {
            metricSelector: "builtin:billing.*",
            fields: "+displayName,+unit,+description,+dimensionDefinitions",
            pageSize: 500,
          },
        });
    for (const m of resp.metrics ?? []) if (m.metricId) out.push(m);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < 5);
  return out;
}

export function registerConsumption(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_consumption_summary",
    {
      description:
        "Consumption / cost drivers over a window. Discovers every billing metric this tenant actually exposes (GET /api/v2/metrics?metricSelector=builtin:billing.*) — host units, DDUs by pool (metrics/logs/events/traces/serverless), synthetic actions, sessions — then queries each one merged across dimensions and returns per-metric totals grouped into cost categories. Discovery, not a hard-coded key list, so it survives Managed-version and license differences; falls back to a curated probe list only if the catalog call fails. Needs metrics.read.",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe("Window start (e.g. 'now-7d', 'now-30d', or ISO). Default: now-7d."),
        to: z.string().optional().describe("Window end. Default: now."),
        resolution: z
          .string()
          .optional()
          .describe(
            "Metric resolution (e.g. '1h', '1d', or 'Inf' for one value per series). Default: Dynatrace picks based on the window."
          ),
        maxMetrics: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cap on discovered billing metrics to query (default 60). Discovery count is always reported."),
        metricSelector: z
          .string()
          .optional()
          .describe("Override the discovery selector. Default 'builtin:billing.*'."),
      },
    },
    async ({ from, to, resolution, maxMetrics, metricSelector }) => {
      const window = { from: from ?? "now-7d", to: to ?? "now" };
      const cap = maxMetrics ?? 60;

      // ---------- 1. discover ----------
      let discovered: CatalogEntry[] = [];
      let discoveryError: string | undefined;
      try {
        if (metricSelector) {
          const resp = await client.get<CatalogResponse>("/api/v2/metrics", {
            query: { metricSelector, fields: "+displayName,+unit,+description,+dimensionDefinitions", pageSize: 500 },
          });
          discovered = (resp.metrics ?? []).filter((m) => m.metricId);
        } else {
          discovered = await discoverBillingMetrics(client);
        }
      } catch (err) {
        discoveryError =
          err instanceof DtApiError
            ? `HTTP ${err.status}${err.status === 403 ? " (metrics.read scope missing)" : ""}: ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : String(err);
        log.warn("billing metric discovery failed; using fallback probes", { error: discoveryError });
      }

      const targets: CatalogEntry[] =
        discovered.length > 0 ? discovered : FALLBACK_PROBES.map((metricId) => ({ metricId }));
      const toQuery = targets.slice(0, cap);

      // ---------- 2. query each, merged across all dimensions ----------
      const metrics: Record<string, unknown> = {};
      const byCategory: Record<Category, string[]> = {
        hostUnits: [],
        dduMetrics: [],
        dduLogs: [],
        dduEvents: [],
        dduTraces: [],
        dduServerless: [],
        synthetic: [],
        sessions: [],
        other: [],
      };
      const categoryTotals: Record<Category, number> = {
        hostUnits: 0,
        dduMetrics: 0,
        dduLogs: 0,
        dduEvents: 0,
        dduTraces: 0,
        dduServerless: 0,
        synthetic: 0,
        sessions: 0,
        other: 0,
      };

      for (const m of toQuery) {
        const category = categorize(m.metricId);
        byCategory[category].push(m.metricId);
        const base = {
          displayName: m.displayName,
          unit: m.unit,
          description: m.description,
          dimensions: (m.dimensionDefinitions ?? []).map((d) => d.key).filter(Boolean),
          category,
        };
        try {
          const query: Record<string, string> = {
            // splitBy() with no arguments merges every dimension into one series.
            metricSelector: `${m.metricId}:splitBy()`,
            from: window.from,
            to: window.to,
          };
          if (resolution) query.resolution = resolution;
          const resp = await client.get<MetricQueryResponse>("/api/v2/metrics/query", { query });
          const { total, samples } = sumValues(resp);
          categoryTotals[category] += total;
          metrics[m.metricId] = { ...base, available: true, samples, total, resolution: resp.resolution };
        } catch (err) {
          if (err instanceof DtApiError) {
            metrics[m.metricId] = {
              ...base,
              available: false,
              error: { status: err.status, body: err.body.slice(0, 200) },
            };
          } else {
            throw err;
          }
        }
      }

      const dominant = (Object.entries(categoryTotals) as Array<[Category, number]>)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([category, total]) => ({ category, total }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                window,
                resolution,
                discovery: {
                  available: !discoveryError,
                  error: discoveryError,
                  selector: metricSelector ?? "builtin:billing.*",
                  found: discovered.length,
                  queried: toQuery.length,
                  truncated: targets.length > toQuery.length,
                  usedFallbackProbes: discovered.length === 0,
                },
                categoryTotals: dominant,
                byCategory,
                metrics,
                notes: [
                  "'total' is a naive sum of the returned data points (all dimensions merged) — use it for relative comparison between categories, not as an invoice. Pass resolution='Inf' for one aggregated value per metric.",
                  "Metric keys are discovered from this tenant's catalog; a category with no entries means this license/version exposes no billing metric for it.",
                  "Metrics with available:false exist in the catalog but could not be queried (see error) — usually a scope or timeframe issue.",
                ],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
