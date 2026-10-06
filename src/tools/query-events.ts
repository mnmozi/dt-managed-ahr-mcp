import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * GET /api/v2/events — search past events.
 *
 * Inverse of dt_post_event: where post_event injects, this one lists what
 * was ingested or auto-detected. Auto-paginates by default; pass
 * singlePage: true to disable.
 *
 * Useful filters:
 *   - eventSelector — same selector grammar as the rest of v2 (e.g.
 *     'eventType("ERROR_EVENT")', 'eventType("DEPLOYMENT")')
 *   - entitySelector — restrict to events attached to specific entities
 *   - from / to — time window (default last 24h)
 */
export function registerQueryEvents(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_query_events",
    {
      description:
        "Search past events (GET /api/v2/events). Inverse of dt_post_event. Filters: eventSelector (e.g. 'eventType(\"ERROR_EVENT\")'), entitySelector, from/to. Auto-paginates up to 10 pages.",
      inputSchema: {
        eventSelector: z
          .string()
          .optional()
          .describe(
            "Event selector. Examples: 'eventType(\"DEPLOYMENT\")', 'eventType(\"ERROR_EVENT\"),correlationId(\"abc\")', 'frequentEvent(true)'."
          ),
        entitySelector: z
          .string()
          .optional()
          .describe(
            "Entity selector to restrict to events attached to specific entities. Examples: 'type(SERVICE),tag(team:payments)'."
          ),
        from: z.string().optional().describe("Start time. Default 'now-24h'."),
        to: z.string().optional().describe("End time. Default 'now'."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Events per page. Server max 1000. Default 100."),
        singlePage: z
          .boolean()
          .optional()
          .describe("If true, return only the first page + nextPageKey. Default false (auto-paginate)."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Cap on auto-paginated pages. Default 10."),
      },
    },
    async ({ eventSelector, entitySelector, from, to, pageSize, singlePage, maxPages }) => {
      const cap = maxPages ?? 10;
      const allEvents: Array<Record<string, unknown>> = [];
      let nextPageKey: string | undefined;
      let pagesFetched = 0;
      let totalEventCount: number | undefined;
      try {
        do {
          const query: Record<string, string | number | undefined> = nextPageKey
            ? { nextPageKey }
            : {
                eventSelector,
                entitySelector,
                from: from ?? "now-24h",
                to: to ?? "now",
                pageSize: pageSize ?? 100,
              };
          const page = await client.get<{
            totalEventCount?: number;
            nextPageKey?: string | null;
            events?: Array<Record<string, unknown>>;
          }>("/api/v2/events", { query });
          if (totalEventCount === undefined) totalEventCount = page.totalEventCount;
          for (const e of page.events ?? []) allEvents.push(e);
          nextPageKey = page.nextPageKey ?? undefined;
          pagesFetched++;
          if (singlePage) break;
          if (pagesFetched >= cap) break;
        } while (nextPageKey);

        // Bucket by eventType for a quick summary — useful for "what's been happening?"
        const byType = new Map<string, number>();
        for (const e of allEvents) {
          const t = (e as { eventType?: unknown }).eventType;
          const key = typeof t === "string" ? t : "UNKNOWN";
          byType.set(key, (byType.get(key) ?? 0) + 1);
        }
        const typeSummary = Array.from(byType.entries())
          .map(([eventType, count]) => ({ eventType, count }))
          .sort((a, b) => b.count - a.count);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    eventSelector: eventSelector ?? null,
                    entitySelector: entitySelector ?? null,
                    returned: allEvents.length,
                    totalEventCount,
                    pagesFetched,
                    truncated: Boolean(nextPageKey),
                    nextPageKey: nextPageKey ?? null,
                    countsByEventType: typeSummary,
                  },
                  events: allEvents,
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
                    partialEvents: allEvents,
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
