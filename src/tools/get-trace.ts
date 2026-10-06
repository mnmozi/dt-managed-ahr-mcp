import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_get_trace — POST /api/v2/spans/query (read-via-POST).
 *
 * EXPERIMENTAL / PROBE. Span querying over REST is a Grail (SaaS) feature
 * (`fetch spans` in DQL); the classic Managed environment API has no public
 * spans-query endpoint, so on most Managed clusters this returns 404. The
 * tool is kept as a cheap probe that reports `available:false` cleanly
 * instead of failing the session. For PurePath-level questions on Managed,
 * use the UI, or `dt_query_metrics` on `builtin:service.*` / request
 * attributes.
 */
export function registerGetTrace(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_trace",
    {
      description:
        "EXPERIMENTAL probe: look up spans for a trace via POST /api/v2/spans/query. Span querying over REST is a Grail/SaaS capability; most Dynatrace Managed clusters have no such endpoint and this returns available:false (404). Provide a traceId or a spanSelector. Read-only; uses the read token (traces.lookup).",
      inputSchema: {
        traceId: z
          .string()
          .optional()
          .describe(
            "Trace id (the W3C trace context id or Dynatrace internal trace id). When provided, the tool builds a selector for you."
          ),
        spanSelector: z
          .string()
          .optional()
          .describe(
            "Custom span selector (e.g. 'spanKind(SERVER),duration(>1s)'). Use INSTEAD of traceId for arbitrary lookups."
          ),
        from: z
          .string()
          .optional()
          .describe("Start time. Default 'now-1h'. Span retention windows on Managed are typically short — keep narrow."),
        to: z.string().optional().describe("End time. Default 'now'."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max spans to return per page. Default 100."),
      },
    },
    async ({ traceId, spanSelector, from, to, pageSize }) => {
      if (!traceId && !spanSelector) {
        return {
          content: [
            {
              type: "text",
              text: "refused: provide either traceId or spanSelector",
            },
          ],
          isError: true,
        };
      }
      const selector = spanSelector ?? `traceId("${traceId}")`;
      const body: Record<string, unknown> = {
        spanSelector: selector,
        from: from ?? "now-1h",
        to: to ?? "now",
        pageSize: pageSize ?? 100,
      };
      try {
        const { status, path, data } = await client.postRead<{
          spans?: Array<Record<string, unknown>>;
          totalCount?: number;
          nextPageKey?: string | null;
        }>("/api/v2/spans/query", body);
        const spans = data.spans ?? [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    httpStatus: status,
                    path,
                    selector,
                    returned: spans.length,
                    totalCount: data.totalCount,
                    nextPageKey: data.nextPageKey ?? null,
                  },
                  spans,
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
                    selector,
                    error: { status: err.status, body: err.body.slice(0, 500) },
                    note:
                      err.status === 404
                        ? "No spans-query endpoint on this environment (expected on Dynatrace Managed — span queries are Grail/SaaS only). Use dt_query_metrics on builtin:service.* metrics or the UI's distributed traces view instead."
                        : undefined,
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
