import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import {
  billingFamily,
  discoverMetrics,
  isAggregateBillingMetric,
} from "../helpers/billing-metrics.js";

interface MetricQueryResponse {
  totalCount?: number;
  resolution?: string;
  result?: Array<{
    metricId?: string;
    data?: Array<{
      dimensions?: string[];
      timestamps?: number[];
      values?: number[];
    }>;
  }>;
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

export function registerConsumption(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_consumption_summary",
    {
      description:
        "Consumption/billing summary over a window. Discovers every builtin:billing.* metric the cluster advertises (keys move between Managed versions — nothing is hardcoded), queries the environment-level aggregate series (usage / total / per-host; per-entity breakdowns are listed but not queried), and returns a per-metric total grouped by family (ddu, full_stack_monitoring, infrastructure_monitoring, log, real_user_monitoring, synthetic, ...). Use to find the categories driving cost, then drill into a family's breakdown metrics with dt_query_metrics.",
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
            "Metric resolution (e.g. '1h', '1d'). Default: leaves Dynatrace to choose based on window."
          ),
        family: z
          .string()
          .optional()
          .describe(
            "Restrict to one billing family (e.g. 'ddu', 'full_stack_monitoring', 'synthetic'). Default: all."
          ),
      },
    },
    async ({ from, to, resolution, family }) => {
      const window = { from: from ?? "now-7d", to: to ?? "now" };

      let advertised;
      try {
        advertised = await discoverMetrics(client, "builtin:billing.*");
      } catch (err) {
        if (!(err instanceof DtApiError)) throw err;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  available: false,
                  reason: "could not list builtin:billing.* metrics",
                  error: { status: err.status, body: err.body.slice(0, 200) },
                  hint: "Requires metrics.read. On Managed the billing metrics exist on every tier; a 403 here is a token-scope problem.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const aggregates = advertised.filter(
        (m) => isAggregateBillingMetric(m.metricId) && (!family || billingFamily(m.metricId) === family)
      );
      const breakdownsSkipped = advertised.filter((m) => !isAggregateBillingMetric(m.metricId)).length;

      const byFamily: Record<string, Record<string, unknown>> = {};
      let queried = 0;
      let failed = 0;
      for (const m of aggregates) {
        const fam = billingFamily(m.metricId);
        byFamily[fam] ??= {};
        try {
          const query: Record<string, string> = {
            metricSelector: m.metricId,
            from: window.from,
            to: window.to,
          };
          if (resolution) query.resolution = resolution;
          const resp = await client.get<MetricQueryResponse>("/api/v2/metrics/query", { query });
          const { total, samples } = sumValues(resp);
          byFamily[fam][m.metricId] = {
            displayName: m.displayName,
            unit: m.unit,
            samples,
            total,
            resolution: resp.resolution,
          };
          queried++;
        } catch (err) {
          if (!(err instanceof DtApiError)) throw err;
          byFamily[fam][m.metricId] = {
            displayName: m.displayName,
            available: false,
            error: { status: err.status, body: err.body.slice(0, 200) },
          };
          failed++;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                window,
                resolution,
                advertisedBillingMetrics: advertised.length,
                aggregateMetricsQueried: queried,
                aggregateMetricsFailed: failed,
                breakdownMetricsSkipped: breakdownsSkipped,
                families: byFamily,
                notes: [
                  "'total' is a naive sum over all returned values — use it for relative comparisons across metrics, not as a billing invoice.",
                  "Metric ids are discovered live from /api/v2/metrics?metricSelector=builtin:billing.* — nothing is hardcoded, so this tool cannot go stale when Managed renames a meter.",
                  "Per-entity / per-key breakdown series (…byEntity, …usage_by_host) are counted but not queried; use dt_query_metrics on a specific one to attribute a large family to entities.",
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
