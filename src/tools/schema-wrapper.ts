import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  scope?: string;
  summary?: string;
  value?: unknown;
  modified?: number;
  [k: string]: unknown;
}

interface SettingsListResponse {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

/**
 * Fetch every object for a given schemaId across all pages.
 * Used by domain wrappers below — they can afford to be exhaustive
 * because AHR schemas (auto-tags, MZs, detection rules) rarely exceed a few hundred objects.
 */
async function fetchAllForSchema(
  client: DtClient,
  schemaId: string,
  pageSize = 500,
  maxPages = 100
): Promise<{ items: SettingsObject[]; totalCount?: number; truncated: boolean }> {
  const all: SettingsObject[] = [];
  let nextPageKey: string | null | undefined;
  let totalCount: number | undefined;
  let pages = 0;

  do {
    const resp = nextPageKey
      ? await client.get<SettingsListResponse>("/api/v2/settings/objects", {
          query: { nextPageKey },
        })
      : await client.get<SettingsListResponse>("/api/v2/settings/objects", {
          query: {
            schemaIds: schemaId,
            pageSize,
            fields: "objectId,schemaId,scope,summary,value,modified",
          },
        });
    if (resp.items) all.push(...resp.items);
    nextPageKey = resp.nextPageKey ?? null;
    if (resp.totalCount !== undefined) totalCount = resp.totalCount;
    pages++;
  } while (nextPageKey && pages < maxPages);

  return { items: all, totalCount, truncated: Boolean(nextPageKey) };
}

/**
 * Registers a thin convenience tool that lists all Settings 2.0 objects for one or more schema IDs.
 */
export function registerSchemaWrapper(
  server: McpServer,
  client: DtClient,
  opts: { toolName: string; description: string; schemaIds: string[] }
): void {
  server.registerTool(
    opts.toolName,
    {
      description: opts.description,
      inputSchema: {
        scopeFilter: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive substring to filter on the 'scope' field (client-side)."
          ),
      },
    },
    async ({ scopeFilter }) => {
      const perSchema: Array<{
        schemaId: string;
        totalCount?: number;
        returned: number;
        truncated: boolean;
        items?: SettingsObject[];
        error?: { status: number; message: string };
      }> = [];
      for (const schemaId of opts.schemaIds) {
        try {
          const { items, totalCount, truncated } = await fetchAllForSchema(client, schemaId);
          const filtered = scopeFilter
            ? items.filter((it) =>
                (it.scope ?? "").toLowerCase().includes(scopeFilter.toLowerCase())
              )
            : items;
          perSchema.push({
            schemaId,
            totalCount,
            returned: filtered.length,
            truncated,
            items: filtered,
          });
        } catch (err) {
          if (err instanceof DtApiError) {
            perSchema.push({
              schemaId,
              returned: 0,
              truncated: false,
              error: { status: err.status, message: err.body.slice(0, 300) },
            });
          } else {
            throw err;
          }
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ schemas: perSchema }, null, 2) }],
      };
    }
  );
}
