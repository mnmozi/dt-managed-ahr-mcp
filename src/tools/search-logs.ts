import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_search_logs — GET /api/v2/logs/search (Log Monitoring Classic).
 *
 * This is the "is my log line landing with the field names my log-event
 * rule expects?" tool. Hand-craft a query, get back matching records + the
 * full set of columns Dynatrace extracted.
 *
 * Managed specifics:
 *   - The endpoint is a GET with query parameters (there is no POST variant).
 *   - Large results are sliced: the response carries `nextSliceKey`; pass it
 *     back as the `nextSliceKey` argument to continue. Slices can be uneven
 *     or even empty.
 *   - Records look like { timestamp, content, status, eventType,
 *     additionalColumns: { <attribute>: [values…] } }. The extracted
 *     attributes live under `additionalColumns`, one array per key.
 *   - Token scope: logs.read. Only Log Monitoring Classic is served here;
 *     Logs on Grail is SaaS-only.
 *
 * Query language is the Dynatrace log search syntax — same as the Logs UI:
 *   container_name="7orr-notifications" AND content="ERROR"
 *   process.technology="nginx" AND loglevel="ERROR"
 */
interface LogRecord {
  timestamp?: number;
  content?: string;
  status?: string;
  eventType?: string;
  additionalColumns?: Record<string, unknown[]>;
  [k: string]: unknown;
}

interface LogSearchResponse {
  results?: LogRecord[];
  sliceSize?: number;
  nextSliceKey?: string | null;
}

export function registerSearchLogs(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_search_logs",
    {
      description:
        "Search ingested logs (GET /api/v2/logs/search, Log Monitoring Classic). Use this to confirm log lines are landing with the expected attribute names BEFORE creating log-event / DPP rules. Returns matching records with their extracted columns (additionalColumns) and the distinct attribute keys seen. Sliced pagination: pass the returned nextSliceKey back to continue. Read-only; uses the read token (needs logs.read). Query syntax is Dynatrace log search (same as the Logs UI).",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Log search query. Examples: 'container_name=\"7orr-notifications\"', 'process.technology=\"nginx\" AND loglevel=\"ERROR\"', 'content=\"timeout\"'. Pass at least one predicate."
          ),
        from: z
          .string()
          .optional()
          .describe("Start time. Relative ('now-15m', 'now-1h', 'now-24h') or absolute ms epoch. Default: 'now-15m'."),
        to: z.string().optional().describe("End time. Default: 'now'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max records per slice. Default 50, server cap 1000."),
        sort: z
          .enum(["-timestamp", "timestamp"])
          .optional()
          .describe("'-timestamp' = newest first (default), 'timestamp' = oldest first. Only timestamp sorting is supported by the API."),
        nextSliceKey: z
          .string()
          .optional()
          .describe("Continuation key from a previous response. When set, the other parameters are ignored by the API."),
      },
    },
    async ({ query, from, to, limit, sort, nextSliceKey }) => {
      const requested = nextSliceKey
        ? { nextSliceKey }
        : {
            query,
            from: from ?? "now-15m",
            to: to ?? "now",
            limit: limit ?? 50,
            sort: sort ?? "-timestamp",
          };
      try {
        const data = await client.get<LogSearchResponse>("/api/v2/logs/search", {
          query: requested,
        });
        const records = data.results ?? [];
        const distinctAttrs = new Set<string>();
        for (const r of records) {
          for (const k of Object.keys(r.additionalColumns ?? {})) distinctAttrs.add(k);
        }
        const summary = {
          requested,
          returned: records.length,
          sliceSize: data.sliceSize,
          nextSliceKey: data.nextSliceKey ?? null,
          distinctAttributeKeys: Array.from(distinctAttrs).sort(),
          note:
            "Extracted attributes are under each record's additionalColumns (one array per key). If a key your log-event rule expects is missing here, the DPP/extraction rule did not fire.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify({ summary, records }, null, 2) }],
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
                    error: { status: err.status, body: err.body.slice(0, 500) },
                    hint:
                      err.status === 403
                        ? "token needs the logs.read scope"
                        : err.status === 404
                          ? "Log Monitoring Classic API not available on this environment (Logs on Grail is SaaS-only)"
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
