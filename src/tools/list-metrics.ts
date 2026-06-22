import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * GET /api/v2/metrics — paginate the metric catalog. Each entry has metricId,
 * displayName, description, unit, dimensionDefinitions, and createdBy.
 *
 * Use this BEFORE constructing a dashboard or a metric query so you know:
 *  - the metric key actually exists on this tenant + version
 *  - what dimensions it supports (so you don't splitBy a non-existent dim)
 *  - what unit it reports in
 *  - whether it's a built-in or a custom/ingested metric
 */
export function registerListMetrics(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_list_metrics",
    {
      description:
        "List metrics from the Dynatrace metrics catalog (GET /api/v2/metrics). Supports a metric selector (e.g. 'builtin:service.*', '*.cpu.*', or a literal key to confirm existence), and pagination. Returns metricId + displayName + unit + dimensionDefinitions per entry. Use this to verify a metric exists on this tenant BEFORE referencing it in dashboards / queries — otherwise the tile will render but show no data.",
      inputSchema: {
        metricSelector: z
          .string()
          .optional()
          .describe(
            "Metric selector. Examples: 'builtin:service.requestCount.total' (literal — confirms one key exists), 'builtin:service.*' (all built-in service metrics), 'builtin:host.cpu.*' (host CPU family), 'custom:*' (all custom metrics). Omit to list everything (uses pagination)."
          ),
        text: z
          .string()
          .optional()
          .describe(
            "Free-text filter that matches against metric id, displayName, description (substring, case-insensitive)."
          ),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max results per page (default 100, server cap 500)."),
        nextPageKey: z
          .string()
          .optional()
          .describe(
            "Pass the nextPageKey returned by the previous call to fetch the next page. When set, all other params are ignored."
          ),
        fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated extra fields to include (default returns metricId only). Useful values: 'unit', 'displayName', 'description', 'dimensionDefinitions', 'aggregationTypes', 'transformations', 'created', 'tags', 'metricValueType'. Pass '+all' for everything."
          ),
      },
    },
    async ({ metricSelector, text, pageSize, nextPageKey, fields }) => {
      try {
        const query: Record<string, string | number | undefined> = nextPageKey
          ? { nextPageKey }
          : {
              metricSelector,
              text,
              pageSize: pageSize ?? 100,
              fields: fields ?? "+displayName,+unit,+dimensionDefinitions,+metricValueType",
            };
        const resp = await client.get<{
          totalCount?: number;
          nextPageKey?: string | null;
          metrics?: Array<{
            metricId: string;
            displayName?: string;
            unit?: string;
            description?: string;
            dimensionDefinitions?: Array<{ key: string; type: string; displayName?: string }>;
            metricValueType?: { type?: string };
          }>;
        }>("/api/v2/metrics", { query });
        const metrics = resp.metrics ?? [];
        const summary = {
          returned: metrics.length,
          totalCount: resp.totalCount,
          nextPageKey: resp.nextPageKey ?? null,
          query: nextPageKey
            ? { nextPageKey }
            : { metricSelector: metricSelector ?? null, text: text ?? null },
        };
        return {
          content: [
            { type: "text", text: JSON.stringify({ summary, metrics }, null, 2) },
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
