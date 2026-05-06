import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

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

/**
 * Curated billing/consumption metric selectors. Not all are present on every
 * Managed deployment — failures per metric are reported but don't fail the tool.
 *
 * Naming follows the dsfm:billing.* convention used by Dynatrace for DDU/host-unit
 * exposure. Some clusters expose only a subset depending on license.
 */
const METRICS: Array<{ key: string; selector: string; description: string }> = [
  {
    key: "hostUnits",
    selector: "builtin:billing.hostunits",
    description: "Host units consumed (the primary licensing meter for host monitoring).",
  },
  {
    key: "fullStackHostUnits",
    selector: "builtin:billing.full_stack_monitoring.usage_per_host",
    description: "Per-host full-stack monitoring usage breakdown.",
  },
  {
    key: "ddu_metrics",
    selector: "builtin:billing.ddu.metrics",
    description: "DDUs consumed by custom metrics.",
  },
  {
    key: "ddu_logs",
    selector: "builtin:billing.ddu.log",
    description: "DDUs consumed by log monitoring.",
  },
  {
    key: "ddu_events",
    selector: "builtin:billing.ddu.events",
    description: "DDUs consumed by events.",
  },
  {
    key: "ddu_traces",
    selector: "builtin:billing.ddu.traces",
    description: "DDUs consumed by distributed traces.",
  },
  {
    key: "ddu_serverless",
    selector: "builtin:billing.ddu.serverless",
    description: "DDUs consumed by serverless monitoring.",
  },
  {
    key: "synthetic_actions",
    selector: "builtin:billing.synthetic.actions",
    description: "Synthetic monitoring actions consumed.",
  },
  {
    key: "session_count",
    selector: "builtin:billing.usersession.user_session_count",
    description: "User sessions billed.",
  },
];

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
        "Pull a curated set of billing/consumption metrics (host units, DDUs by category, synthetic actions, sessions) over a window and return a per-metric summary. Each metric is fetched independently — metrics not exposed on this license return 'unavailable' rather than failing the tool. Use this to find unexpectedly large categories driving cost.",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe("Window start (e.g. 'now-7d', 'now-30d', or ISO). Default: now-7d."),
        to: z
          .string()
          .optional()
          .describe("Window end. Default: now."),
        resolution: z
          .string()
          .optional()
          .describe(
            "Metric resolution (e.g. '1h', '1d'). Default: leaves Dynatrace to choose based on window."
          ),
      },
    },
    async ({ from, to, resolution }) => {
      const window = { from: from ?? "now-7d", to: to ?? "now" };
      const out: Record<string, unknown> = {};

      for (const m of METRICS) {
        try {
          const query: Record<string, string> = {
            metricSelector: m.selector,
            from: window.from,
            to: window.to,
          };
          if (resolution) query.resolution = resolution;
          const resp = await client.get<MetricQueryResponse>("/api/v2/metrics/query", { query });
          const { total, samples } = sumValues(resp);
          out[m.key] = {
            description: m.description,
            metricSelector: m.selector,
            available: true,
            samples,
            total,
            resolution: resp.resolution,
          };
        } catch (err) {
          if (err instanceof DtApiError) {
            out[m.key] = {
              description: m.description,
              metricSelector: m.selector,
              available: false,
              error: { status: err.status, body: err.body.slice(0, 200) },
            };
          } else {
            throw err;
          }
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
                metrics: out,
                notes: [
                  "'total' is a naive sum over all returned values — use it for relative comparisons across metrics, not as a billing invoice.",
                  "Metrics shown as 'available: false' may not be exposed on this license tier or may have moved to a different selector across DT versions.",
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
