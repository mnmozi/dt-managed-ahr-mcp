import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_search_entities — GET /api/v2/entities with entitySelector.
 *
 * Find entities by selector — the inverse of "I have a tag and I want to see
 * who has it". Selector syntax mirrors the dashboard / SLO selectors:
 *   type(SERVICE),tag(team:7orr)
 *   type(HOST),hostGroupName(prod-web)
 *   type(PROCESS_GROUP_INSTANCE),fromRelationships.runs(type(HOST),hostGroupName(prod-web))
 *
 * Auto-paginates by default (up to 10 pages) so callers don't have to handle
 * nextPageKey themselves — pass `singlePage: true` to disable.
 */
export function registerSearchEntities(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_search_entities",
    {
      description:
        "Find entities by selector (GET /api/v2/entities). Selector syntax: type(SERVICE),tag(team:7orr). Returns entityId + displayName + tags + properties. Auto-paginates up to 10 pages; pass singlePage:true to disable.",
      inputSchema: {
        entitySelector: z
          .string()
          .min(1)
          .describe(
            "Entity selector. Examples: 'type(SERVICE)' (all services), 'type(HOST),tag(env:prod)', 'type(PROCESS_GROUP_INSTANCE),fromRelationships.runs(type(HOST),hostGroupName(\"prod-web\"))'."
          ),
        from: z
          .string()
          .optional()
          .describe("Time window start for tag/property snapshot. Default 'now-24h'."),
        to: z
          .string()
          .optional()
          .describe("Time window end. Default 'now'."),
        fields: z
          .string()
          .optional()
          .describe(
            "Extra fields to project. Examples: '+tags', '+properties', '+managementZones', '+fromRelationships', '+toRelationships'. Default '+tags,+managementZones'. Pass '+properties' to include the noisy properties bag."
          ),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(4000)
          .optional()
          .describe("Page size, server max 4000. Default 500."),
        singlePage: z
          .boolean()
          .optional()
          .describe("If true, return only the first page and surface nextPageKey. Default false (auto-paginate up to 10 pages)."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Cap on auto-paginated pages. Default 10."),
      },
    },
    async ({ entitySelector, from, to, fields, pageSize, singlePage, maxPages }) => {
      const cap = maxPages ?? 10;
      const allEntities: Array<Record<string, unknown>> = [];
      let nextPageKey: string | undefined;
      let pagesFetched = 0;
      let totalCount: number | undefined;
      try {
        do {
          const query: Record<string, string | number | undefined> = nextPageKey
            ? { nextPageKey }
            : {
                entitySelector,
                from: from ?? "now-24h",
                to: to ?? "now",
                fields: fields ?? "+tags,+managementZones",
                pageSize: pageSize ?? 500,
              };
          const page = await client.get<{
            totalCount?: number;
            nextPageKey?: string | null;
            entities?: Array<Record<string, unknown>>;
          }>("/api/v2/entities", { query });
          if (totalCount === undefined) totalCount = page.totalCount;
          for (const e of page.entities ?? []) allEntities.push(e);
          nextPageKey = page.nextPageKey ?? undefined;
          pagesFetched++;
          if (singlePage) break;
          if (pagesFetched >= cap) break;
        } while (nextPageKey);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    entitySelector,
                    returned: allEntities.length,
                    totalCount,
                    pagesFetched,
                    truncated: Boolean(nextPageKey),
                    nextPageKey: nextPageKey ?? null,
                  },
                  entities: allEntities,
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
                  {
                    available: false,
                    pagesFetched,
                    partialEntities: allEntities,
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
