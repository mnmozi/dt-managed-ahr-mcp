import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_query_metrics — GET /api/v2/metrics/query
 *
 * Run a metric selector and get data points back. This is the "Data Explorer
 * in tool form" — the same query you'd put in a dashboard tile.
 *
 * The metric selector supports the full transform chain:
 *   builtin:service.requestCount.total
 *   builtin:service.requestCount.total:splitBy("dt.entity.service"):sort(value(auto,descending))
 *   builtin:host.cpu.usage:filter(eq("dt.entity.host", "HOST-ABC"))
 *
 * Response shape includes `result[].data[].values[]` — the raw points. We
 * also surface a `compact` representation that flattens `{ name, dims, points: [{t, v}] }`
 * for series — easier for an LLM to reason about than the nested original.
 */
export function registerQueryMetrics(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_query_metrics",
    {
      description:
        "Query metric data (GET /api/v2/metrics/query) with a full metric selector + timeframe + resolution. Returns both the raw Dynatrace response and a flattened compact form (one entry per series with point arrays). Read-only.",
      inputSchema: {
        metricSelector: z
          .string()
          .min(1)
          .describe(
            "Full metric selector. Examples: 'builtin:service.requestCount.total', 'builtin:host.cpu.usage:splitBy(\"dt.entity.host\")', 'builtin:service.errors.total:filter(in(\"dt.entity.service\", \"SERVICE-A\", \"SERVICE-B\"))'."
          ),
        from: z
          .string()
          .optional()
          .describe("Start time. Relative ('now-1h', 'now-24h', 'now-7d') or absolute ms epoch. Default 'now-1h'."),
        to: z
          .string()
          .optional()
          .describe("End time. Default 'now'."),
        resolution: z
          .string()
          .optional()
          .describe(
            "Resolution. Examples: '1m', '5m', '1h'. Or 'Inf' for a single aggregate over the entire window. Server picks a sensible default if omitted."
          ),
        entitySelector: z
          .string()
          .optional()
          .describe(
            "Optional entity selector to scope the query, e.g. 'type(SERVICE),tag(team:payments)'."
          ),
        mzSelector: z
          .string()
          .optional()
          .describe("Optional management-zone selector, e.g. 'mzName(\"Prod\")'."),
      },
    },
    async ({ metricSelector, from, to, resolution, entitySelector, mzSelector }) => {
      try {
        const resp = await client.get<{
          totalCount?: number;
          nextPageKey?: string | null;
          resolution?: string;
          result?: Array<{
            metricId: string;
            data?: Array<{
              dimensions?: string[];
              dimensionMap?: Record<string, string>;
              timestamps?: number[];
              values?: number[];
            }>;
          }>;
        }>("/api/v2/metrics/query", {
          query: {
            metricSelector,
            from: from ?? "now-1h",
            to: to ?? "now",
            resolution,
            entitySelector,
            mzSelector,
          },
        });

        // Flatten into a compact form the LLM can summarize without the
        // nested arrays-of-arrays of the original response.
        const compact: Array<{
          metricId: string;
          dimensions: Record<string, string>;
          pointCount: number;
          firstPoint: { t: number; v: number } | null;
          lastPoint: { t: number; v: number } | null;
          min: number | null;
          max: number | null;
          avg: number | null;
        }> = [];
        for (const r of resp.result ?? []) {
          for (const d of r.data ?? []) {
            const ts = d.timestamps ?? [];
            const vs = d.values ?? [];
            const nonNull = vs.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
            const firstIdx = vs.findIndex((v) => typeof v === "number" && !Number.isNaN(v));
            const lastIdx = (() => {
              for (let i = vs.length - 1; i >= 0; i--) {
                if (typeof vs[i] === "number" && !Number.isNaN(vs[i] as number)) return i;
              }
              return -1;
            })();
            compact.push({
              metricId: r.metricId,
              dimensions: d.dimensionMap ?? {},
              pointCount: vs.length,
              firstPoint:
                firstIdx >= 0 && ts[firstIdx] !== undefined
                  ? { t: ts[firstIdx] as number, v: vs[firstIdx] as number }
                  : null,
              lastPoint:
                lastIdx >= 0 && ts[lastIdx] !== undefined
                  ? { t: ts[lastIdx] as number, v: vs[lastIdx] as number }
                  : null,
              min: nonNull.length ? Math.min(...nonNull) : null,
              max: nonNull.length ? Math.max(...nonNull) : null,
              avg: nonNull.length ? nonNull.reduce((a, b) => a + b, 0) / nonNull.length : null,
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    metricSelector,
                    resolution: resp.resolution,
                    seriesCount: compact.length,
                    requestedWindow: { from: from ?? "now-1h", to: to ?? "now" },
                  },
                  compact,
                  raw: resp,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof DtApiError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { available: false, error: { status: err.status, body: err.body.slice(0, 500) } },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );
}
