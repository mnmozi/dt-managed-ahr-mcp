import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { auditLogMetricUsage } from "../helpers/log-metric-usage.js";
import { textResult } from "../helpers/tool-result.js";

export function registerAuditLogMetricUsage(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_audit_log_metric_usage",
    {
      description:
        "Read-only. For every log.* metric produced by a log metric-extraction rule (builtin:logmonitoring.schemaless-log-metric, legacy metric-extraction), find its consumers — metric events (builtin:anomaly-detection.metric-events), SLOs (/api/v2/slo metric expressions) and Config v1 dashboard tiles — and check whether it has data in the window. Buckets: broken (consumed but no data / rule disabled — alerts and SLOs silently empty), orphan (data but no consumer — DDU-metrics cost for nothing), dead (no consumer, no data), recent (inside grace period), inconclusive, used. 'orphan' means no IN-TENANT consumer: external Metrics API readers and ad-hoc Data Explorer use are invisible, so confirm before deleting. Check `conclusive` and `coverage` — if a consumer source failed to load, orphan/dead are candidates only.",
      inputSchema: {
        from: z.string().optional().describe("Data-presence window start. Default now-30d."),
        to: z.string().optional().describe("Data-presence window end. Default now."),
        graceDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Rules created within this many days are bucketed 'recent' instead of orphan/dead. Default 14."),
        maxDashboards: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Cap on dashboards fetched individually. Default 1000; coverage reports truncation."),
      },
    },
    async ({ from, to, graceDays, maxDashboards }) => {
      const report = await auditLogMetricUsage(client, {
        from: from ?? "now-30d",
        to: to ?? "now",
        graceDays: graceDays ?? 14,
        maxDashboards: maxDashboards ?? 1000,
      });
      return textResult(report);
    }
  );
}
