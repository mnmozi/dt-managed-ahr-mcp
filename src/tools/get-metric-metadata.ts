import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * GET /api/v2/metrics/{metricKey} — full metadata for one metric.
 *
 * Returns 404 if the metric doesn't exist on this tenant; the tool surfaces
 * that as `{ exists: false }` rather than throwing, which makes it cheap to
 * use as a pre-flight check for dashboard tile queries.
 */
export function registerGetMetricMetadata(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_metric_metadata",
    {
      description:
        "Get full metadata for ONE metric by its key (GET /api/v2/metrics/{key}). Returns unit, displayName, description, dimensionDefinitions, aggregationTypes, default aggregation. Useful as a pre-flight check before referencing the metric in a dashboard or query. Returns { exists: false } on 404 (key not on this tenant) instead of throwing.",
      inputSchema: {
        metricKey: z
          .string()
          .min(1)
          .describe(
            "Full metric key, e.g. 'builtin:service.requestCount.total' or 'custom:my.app.payments.failed'. Selectors with transforms are NOT supported here — use dt_list_metrics for that."
          ),
      },
    },
    async ({ metricKey }) => {
      const encoded = encodeURIComponent(metricKey);
      try {
        const data = await client.get<unknown>(`/api/v2/metrics/${encoded}`);
        return {
          content: [
            { type: "text", text: JSON.stringify({ exists: true, metric: data }, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof DtApiError) {
          if (err.status === 404) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ exists: false, metricKey, status: 404 }, null, 2),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    exists: false,
                    metricKey,
                    error: { status: err.status, body: err.body.slice(0, 500) },
                  },
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
