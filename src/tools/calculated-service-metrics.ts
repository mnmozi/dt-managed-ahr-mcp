import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsListResponse {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: Array<{
    objectId?: string;
    schemaId?: string;
    scope?: string;
    summary?: string;
    value?: unknown;
    modified?: number;
  }>;
}

interface V1CalculatedMetricListResponse {
  values?: Array<{ id?: string; name?: string }>;
}

/**
 * Calculated service metrics live on two surfaces in Managed and the schema id
 * varies by version, so we probe both Settings 2.0 candidates and the older
 * config v1 endpoint.
 */
const CANDIDATE_SCHEMAS = [
  "builtin:metric.calculated.services",
  "builtin:metric.custom.services",
  "builtin:custom-services.metrics",
  "builtin:service.calculated-metric",
];

export function registerCalculatedServiceMetrics(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_calculated_service_metrics",
    {
      description:
        "List calculated service metrics. Tries Settings 2.0 (multiple schema id candidates across DT versions) AND Config API v1 (/api/config/v1/calculatedMetrics/service). Use to find: dead metrics (defined but unused), redundant metrics, metrics with overly broad scope.",
      inputSchema: {
        includeV1Details: z
          .boolean()
          .optional()
          .describe("If true, fetches each v1 metric's full body. Default false."),
      },
    },
    async ({ includeV1Details }) => {
      const result: {
        settings2: Record<string, unknown>;
        configV1: { available: boolean; count?: number; items?: unknown[]; error?: string };
      } = {
        settings2: {},
        configV1: { available: false },
      };

      // Settings 2.0 — probe candidates
      for (const schemaId of CANDIDATE_SCHEMAS) {
        try {
          const all: unknown[] = [];
          let nextPageKey: string | null | undefined;
          let pages = 0;
          do {
            const resp = nextPageKey
              ? await client.get<SettingsListResponse>("/api/v2/settings/objects", {
                  query: { nextPageKey },
                })
              : await client.get<SettingsListResponse>("/api/v2/settings/objects", {
                  query: {
                    schemaIds: schemaId,
                    pageSize: 500,
                    fields: "objectId,schemaId,scope,summary,value,modified",
                  },
                });
            if (resp.items) all.push(...resp.items);
            nextPageKey = resp.nextPageKey ?? null;
            pages++;
          } while (nextPageKey && pages < 20);
          result.settings2[schemaId] = { available: true, count: all.length, items: all };
        } catch (err) {
          if (err instanceof DtApiError) {
            result.settings2[schemaId] = {
              available: false,
              error: `${err.status}: ${err.body.slice(0, 200)}`,
            };
          } else {
            throw err;
          }
        }
      }

      // Config v1
      try {
        const list = await client.get<V1CalculatedMetricListResponse>(
          "/api/config/v1/calculatedMetrics/service"
        );
        const values = list.values ?? [];
        if (!includeV1Details) {
          result.configV1 = { available: true, count: values.length, items: values };
        } else {
          const detailed: unknown[] = [];
          for (const m of values) {
            if (!m.id) continue;
            try {
              const detail = await client.get<unknown>(
                `/api/config/v1/calculatedMetrics/service/${encodeURIComponent(m.id)}`
              );
              detailed.push(detail);
            } catch (err) {
              detailed.push({
                id: m.id,
                name: m.name,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          result.configV1 = { available: true, count: detailed.length, items: detailed };
        }
      } catch (err) {
        if (err instanceof DtApiError) {
          result.configV1 = {
            available: false,
            error: `${err.status}: ${err.body.slice(0, 200)}`,
          };
        } else {
          result.configV1 = { available: false, error: String(err) };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
