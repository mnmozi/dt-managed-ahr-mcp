import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_get_trace — POST /api/v2/spans/query (read-via-POST).
 *
 * Looks up spans by traceId (the typical case) or by an arbitrary span
 * selector. Returns the spans that match, sorted by startTime.
 *
 * If the endpoint isn't present on this Managed version (older clusters
 * exposed v1 PurePath endpoints under /api/v1/entity/services/...), the call
 * comes back as a 404 with the underlying error so the caller can fall
 * back to dt_raw_post / dt_raw_get against the v1 path.
 */
export function registerGetTrace(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_trace",
    {
      description:
        "Look up spans for a trace (POST /api/v2/spans/query) — Managed's modern PurePath endpoint. Provide a traceId for the typical case, or a custom selector / advancedSelector for arbitrary queries. Read-only; uses the read token (token must have traces.lookup scope).",
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
                        ? "Endpoint not present on this Managed version. Older clusters used /api/v1/entity/services/{id}/requests/... — fall back via dt_raw_get."
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
