import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * GET /api/v2/slo/{sloId} — single SLO read.
 *
 * The upstream MCP has list/details too, but ours has create/update/delete
 * without a corresponding read until now. This closes the gap.
 */
export function registerGetSlo(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_slo",
    {
      description:
        "Read one SLO by id (GET /api/v2/slo/{id}). Returns current value, error budget, days-to-breach at current burn rate, status. Companion to dt_create_slo / dt_update_slo / dt_delete_slo.",
      inputSchema: {
        sloId: z.string().min(1).describe("SLO id."),
        timeframe: z
          .string()
          .optional()
          .describe("Override the SLO's evaluation timeframe for this read, e.g. '-30d'. Defaults to the SLO's configured timeframe."),
      },
    },
    async ({ sloId, timeframe }) => {
      const encoded = encodeURIComponent(sloId);
      try {
        const data = await client.get<unknown>(`/api/v2/slo/${encoded}`, {
          query: { timeframe },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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
