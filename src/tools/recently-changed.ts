import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  scope?: string;
  modified?: number;
  summary?: string;
  [k: string]: unknown;
}

interface SettingsListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

const DEFAULT_SCHEMAS = [
  "builtin:tags.auto-tagging",
  "builtin:management-zones",
  "builtin:process-group.advanced-detection-rule",
  "builtin:process-group.detection-flags",
  "builtin:service-detection.full-web-service",
  "builtin:service-detection.full-web-request",
  "builtin:service.request-naming",
  "builtin:service.request-attributes",
  "builtin:alerting.profile",
  "builtin:alerting.maintenance-window",
  "builtin:problem.notifications",
  "builtin:anomaly-detection.metric-events",
  "builtin:anomaly-detection.services",
  "builtin:anomaly-detection.infrastructure-hosts",
  "builtin:host.process-monitoring",
  "builtin:logmonitoring.processing-rule",
  "builtin:logmonitoring.log-storage-settings",
  "builtin:span-capturing",
  "builtin:network-zones",
  "builtin:custom-service",
];

export function registerRecentlyChanged(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_recently_changed_settings",
    {
      description:
        "List Settings 2.0 objects modified within the last N days, grouped by schema. Use to spot config churn (rules being repeatedly tweaked, recently disabled rules, automation churn). Pair with dt_get_audit_log_entries to attribute changes to users.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Look-back window in days. Default 30."),
        schemaIds: z
          .array(z.string())
          .optional()
          .describe(
            "Override the default curated schema list. Pass a custom set of schema ids to inspect."
          ),
      },
    },
    async ({ days, schemaIds }) => {
      const cutoffDays = days ?? 30;
      const cutoff = Date.now() - cutoffDays * 86400000;
      const schemas = schemaIds && schemaIds.length > 0 ? schemaIds : DEFAULT_SCHEMAS;

      const perSchema: Array<{
        schemaId: string;
        totalChanged: number;
        items: SettingsObject[];
        error?: string;
      }> = [];
      let grandTotal = 0;

      for (const schemaId of schemas) {
        try {
          const all: SettingsObject[] = [];
          let nextPageKey: string | null | undefined;
          let pages = 0;
          do {
            const resp = nextPageKey
              ? await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: { nextPageKey },
                })
              : await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: {
                    schemaIds: schemaId,
                    pageSize: 500,
                    fields: "objectId,schemaId,scope,summary,modified",
                  },
                });
            for (const it of resp.items ?? []) {
              if ((it.modified ?? 0) >= cutoff) all.push(it);
            }
            nextPageKey = resp.nextPageKey ?? null;
            pages++;
          } while (nextPageKey && pages < 50);
          if (all.length > 0) {
            perSchema.push({ schemaId, totalChanged: all.length, items: all });
            grandTotal += all.length;
          }
        } catch (err) {
          if (err instanceof DtApiError) {
            perSchema.push({
              schemaId,
              totalChanged: 0,
              items: [],
              error: `${err.status}: ${err.body.slice(0, 200)}`,
            });
          } else {
            throw err;
          }
        }
      }

      const summary = {
        windowDays: cutoffDays,
        cutoffEpochMs: cutoff,
        scannedSchemas: schemas.length,
        schemasWithChanges: perSchema.filter((p) => p.totalChanged > 0).length,
        totalChangedObjects: grandTotal,
        perSchema: perSchema.sort((a, b) => b.totalChanged - a.totalChanged),
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
