import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  schemaVersion?: string;
  scope?: string;
  value?: unknown;
  summary?: string;
  created?: number;
  modified?: number;
  [k: string]: unknown;
}

interface SettingsListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

export function registerListSettingsObjects(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_list_settings_objects",
    {
      description:
        "List Settings 2.0 objects for one or more schemas. Returns objectId, scope, summary, and (by default) the full value. Handles pagination automatically up to maxPages.",
      inputSchema: {
        schemaIds: z
          .string()
          .describe(
            "Comma-separated list of schema IDs (e.g. 'builtin:tags.auto-tagging' or 'builtin:management-zones,builtin:tags.auto-tagging')."
          ),
        scopes: z
          .string()
          .optional()
          .describe("Optional comma-separated scopes (e.g. 'environment' or a specific entity id)."),
        fields: z
          .string()
          .optional()
          .describe(
            "Optional fields selector passed through to Dynatrace (e.g. 'objectId,value,summary,scope'). If omitted, a useful default is used."
          ),
        pageSize: z.number().int().min(1).max(500).optional().describe("Page size (default 500)."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max pages to fetch before stopping (default 50, max 500). The response includes truncated:true if more pages remain — re-call with a higher value or use nextPageKey."),
      },
    },
    async ({ schemaIds, scopes, fields, pageSize, maxPages }) => {
      const defaultFields = "objectId,schemaId,schemaVersion,scope,summary,value,created,modified";
      const all: SettingsObject[] = [];
      let nextPageKey: string | null | undefined;
      let pagesFetched = 0;
      const cap = maxPages ?? 50;
      let totalCount: number | undefined;

      do {
        const query: Record<string, string | number> = {
          schemaIds,
          pageSize: pageSize ?? 500,
          fields: fields ?? defaultFields,
        };
        if (scopes) query.scopes = scopes;
        if (nextPageKey) {
          // When nextPageKey is set, it must be the only parameter besides itself
          // per DT contract — send nextPageKey alone.
          const resp = await client.get<SettingsListResponse>("/api/v2/settings/objects", {
            query: { nextPageKey },
          });
          if (resp.items) all.push(...resp.items);
          nextPageKey = resp.nextPageKey ?? null;
          if (resp.totalCount !== undefined) totalCount = resp.totalCount;
        } else {
          const resp = await client.get<SettingsListResponse>("/api/v2/settings/objects", { query });
          if (resp.items) all.push(...resp.items);
          nextPageKey = resp.nextPageKey ?? null;
          totalCount = resp.totalCount;
        }
        pagesFetched++;
      } while (nextPageKey && pagesFetched < cap);

      const truncated = Boolean(nextPageKey);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schemaIds,
                totalCount,
                returned: all.length,
                pagesFetched,
                truncated,
                nextPageKey: truncated ? nextPageKey : null,
                items: all,
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
