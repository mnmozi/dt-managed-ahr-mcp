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

interface V1MwListResponse {
  values?: Array<{ id?: string; name?: string; type?: string; description?: string }>;
}

/**
 * Maintenance windows live on two surfaces in Managed:
 *  - Settings 2.0: builtin:alerting.maintenance-window (newer, preferred)
 *  - Config v1: /api/config/v1/maintenanceWindows (older, still present)
 * This tool tries Settings 2.0 first; if the schema isn't on this version, it
 * falls back to v1 and returns whichever surface had data (or both).
 */
export function registerMaintenanceWindows(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_maintenance_windows",
    {
      description:
        "Inventory all maintenance windows. Tries Settings 2.0 (builtin:alerting.maintenance-window) AND Config API v1 (/api/config/v1/maintenanceWindows) so you see whatever the cluster has. Use to find: dead MWs (always-active never-ends), perma-MWs masking real alerts, MWs with no scope (apply to everything), and overlapping MWs.",
      inputSchema: {
        includeV1Details: z
          .boolean()
          .optional()
          .describe(
            "If true, fetches each v1 MW's full body (extra calls). Default false — list only."
          ),
      },
    },
    async ({ includeV1Details }) => {
      const result: {
        settings2: { available: boolean; count?: number; items?: unknown[]; error?: string };
        configV1: { available: boolean; count?: number; items?: unknown[]; error?: string };
      } = {
        settings2: { available: false },
        configV1: { available: false },
      };

      // Settings 2.0 attempt
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
                  schemaIds: "builtin:alerting.maintenance-window",
                  pageSize: 500,
                  fields: "objectId,schemaId,scope,summary,value,modified",
                },
              });
          if (resp.items) all.push(...resp.items);
          nextPageKey = resp.nextPageKey ?? null;
          pages++;
        } while (nextPageKey && pages < 20);
        result.settings2 = { available: true, count: all.length, items: all };
      } catch (err) {
        if (err instanceof DtApiError) {
          result.settings2 = {
            available: false,
            error: `${err.status}: ${err.body.slice(0, 200)}`,
          };
        } else {
          result.settings2 = { available: false, error: String(err) };
        }
      }

      // Config v1 attempt
      try {
        const list = await client.get<V1MwListResponse>("/api/config/v1/maintenanceWindows");
        const values = list.values ?? [];
        if (!includeV1Details) {
          result.configV1 = { available: true, count: values.length, items: values };
        } else {
          const detailed: unknown[] = [];
          for (const mw of values) {
            if (!mw.id) continue;
            try {
              const detail = await client.get<unknown>(
                `/api/config/v1/maintenanceWindows/${encodeURIComponent(mw.id)}`
              );
              detailed.push(detail);
            } catch (err) {
              detailed.push({
                id: mw.id,
                name: mw.name,
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
