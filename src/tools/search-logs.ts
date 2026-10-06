import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_search_logs — POST /api/v2/logs/search (the Managed log search endpoint).
 *
 * This is the "is my log line landing with the field names my log-event rule
 * expects?" tool. Hand-craft a query, get back matching lines + the full
 * field set Dynatrace extracted.
 *
 * Query language is Dynatrace's log search syntax — same as the Logs UI:
 *   container_name="shop-notifications" AND content="ERROR"
 *   process.technology="nginx" AND loglevel="ERROR"
 *   snmp.trap_oid="F5-BIGIP-COMMON-MIB::*"
 *
 * Tips for the LLM:
 *  - Always pass `from`/`to` (relative is fine: 'now-15m', 'now'). Default
 *    timeframe is recent but Dynatrace docs warn it can be implementation-
 *    defined.
 *  - Set a small `limit` (10-50) for exploration. Server cap is 1000.
 *  - The response includes `result.records[i]` with `content`, `timestamp`,
 *    and `attributes` (a dict of all extracted fields). The attributes dict
 *    is where you'll see whether your custom DPP rule actually wrote
 *    `status` / `loglevel` / `trace_id` etc.
 */
export function registerSearchLogs(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_search_logs",
    {
      description:
        "Search ingested logs (POST /api/v2/logs/search). Use this to confirm log lines are landing with the expected attribute names BEFORE creating log-event rules. Returns matching records with full extracted attribute set. Read-only; uses the read token. Query syntax is Dynatrace log search (same as the Logs UI).",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Log search query. Examples: 'container_name=\"shop-notifications\"', 'process.technology=\"nginx\" AND loglevel=\"ERROR\"', 'content=\"timeout\"'. Empty match-all not allowed — pass at least one predicate."
          ),
        from: z
          .string()
          .optional()
          .describe("Start time. Relative ('now-15m', 'now-1h', 'now-24h') or absolute ms epoch. Default: 'now-15m'."),
        to: z
          .string()
          .optional()
          .describe("End time. Default: 'now'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max records to return. Default 50, server cap 1000."),
        sort: z
          .string()
          .optional()
          .describe("Sort spec, e.g. '-timestamp' (newest first, default) or '+timestamp' (oldest first)."),
      },
    },
    async ({ query, from, to, limit, sort }) => {
      const body = {
        query,
        from: from ?? "now-15m",
        to: to ?? "now",
        limit: limit ?? 50,
        sort: sort ?? "-timestamp",
      };
      try {
        const { status, path, data } = await client.postRead<{
          result?: {
            records?: Array<{
              timestamp?: string;
              content?: string;
              attributes?: Record<string, unknown>;
            }>;
            totalCount?: number;
          };
        }>("/api/v2/logs/search", body);
        const records = data.result?.records ?? [];
        const distinctAttrs = new Set<string>();
        for (const r of records) {
          for (const k of Object.keys(r.attributes ?? {})) distinctAttrs.add(k);
        }
        const summary = {
          httpStatus: status,
          path,
          requested: body,
          returned: records.length,
          totalCount: data.result?.totalCount,
          distinctAttributeKeys: Array.from(distinctAttrs).sort(),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify({ summary, records }, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof DtApiError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { available: false, error: { status: err.status, body: err.body.slice(0, 500) } },
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
