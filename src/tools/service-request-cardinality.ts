import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface MetricQueryResponse {
  totalCount?: number;
  resolution?: string;
  result?: Array<{
    metricId?: string;
    data?: Array<{
      dimensions?: string[];
      dimensionMap?: Record<string, string>;
      timestamps?: number[];
      values?: number[];
    }>;
  }>;
}

const HIGH_CARDINALITY_THRESHOLD = 100; // distinct request names per service is the smell

export function registerServiceRequestCardinality(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_service_request_cardinality",
    {
      description:
        "Inspect request-name cardinality for a SERVICE: how many distinct request names it serves over a window, plus the top-N by call count. High cardinality (default >100) signals a missing request-naming rule that's letting per-id endpoints (like /user/123) become unique requests.",
      inputSchema: {
        serviceId: z
          .string()
          .min(1)
          .describe("SERVICE entity id, e.g. 'SERVICE-1234ABCD'."),
        from: z
          .string()
          .optional()
          .describe("Window start (e.g. 'now-24h', 'now-7d'). Default: now-24h."),
        to: z.string().optional().describe("Window end. Default: now."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many top request names to return. Default 25."),
        threshold: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `Cardinality threshold above which the result is flagged as high-cardinality. Default ${HIGH_CARDINALITY_THRESHOLD}.`
          ),
      },
    },
    async ({ serviceId, from, to, topN, threshold }) => {
      const window = { from: from ?? "now-24h", to: to ?? "now" };
      const limit = topN ?? 25;
      const flagThreshold = threshold ?? HIGH_CARDINALITY_THRESHOLD;

      // Split builtin:service.requestCount.total by SERVICE_METHOD entity (each is a
      // distinct request name). `:names` adds the human-readable
      // dt.entity.service_method.name dimension next to the entity id.
      const metricSelector = `builtin:service.requestCount.total:splitBy("dt.entity.service_method"):names:sort(value(auto,descending)):limit(${limit})`;
      const entitySelector = `type(SERVICE),entityId(${serviceId})`;

      const data = await client.get<MetricQueryResponse>("/api/v2/metrics/query", {
        query: {
          metricSelector,
          entitySelector,
          from: window.from,
          to: window.to,
          resolution: "Inf", // single value per series for the whole window
        },
      });

      const series = data.result?.[0]?.data ?? [];
      const top = series.map((s) => {
        const dm = s.dimensionMap ?? {};
        const requestId = dm["dt.entity.service_method"] ?? s.dimensions?.[0];
        const requestName = dm["dt.entity.service_method.name"] ?? requestId;
        return {
          requestId,
          requestName,
          callCount: (s.values ?? []).reduce(
            (a, b) => (typeof b === "number" && !Number.isNaN(b) ? a + b : a),
            0
          ),
        };
      });

      // To get the TRUE distinct count we ideally need a separate query without the limit.
      // Workaround: query again with a high limit (e.g. 1000) and take the series count.
      const countSelector = `builtin:service.requestCount.total:splitBy("dt.entity.service_method"):limit(1000)`;
      const distinctResp = await client.get<MetricQueryResponse>("/api/v2/metrics/query", {
        query: {
          metricSelector: countSelector,
          entitySelector,
          from: window.from,
          to: window.to,
          resolution: "Inf",
        },
      });
      const distinctSeries = distinctResp.result?.[0]?.data ?? [];
      const distinctCount = distinctSeries.length;
      const distinctCountIsApprox = distinctCount >= 1000;

      const isHighCardinality = distinctCount >= flagThreshold;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                serviceId,
                window,
                distinctRequestNames: distinctCount,
                distinctCountIsApprox,
                threshold: flagThreshold,
                isHighCardinality,
                hint: isHighCardinality
                  ? `Service has >=${flagThreshold} distinct request names — strong indicator that a request-naming rule is missing (per-id endpoints leaking through). Check dt_get_request_naming for existing rules covering this service.`
                  : "Cardinality looks bounded; request-naming may not be the issue here.",
                top,
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
