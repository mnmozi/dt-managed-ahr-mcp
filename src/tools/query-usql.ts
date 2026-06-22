import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_query_usql — GET /api/v1/userSessionQueryLanguage/table
 *
 * Run a USQL (User Session Query Language) query. USQL is SQL-ish over RUM
 * session/event data. Useful for digging into RUM behavior from the agent:
 *
 *   SELECT useraction.name, count(*) FROM useraction
 *   WHERE useraction.application = "my-app" GROUP BY useraction.name
 *
 * The endpoint returns a column-oriented shape `{ columnNames, values }` —
 * we flatten that into row objects for easier LLM consumption.
 *
 * Token scope: DTAQLAccess (or equivalent for the cluster version).
 */
export function registerQueryUsql(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_query_usql",
    {
      description:
        "Run a USQL (User Session Query Language) query against RUM data (GET /api/v1/userSessionQueryLanguage/table). Examples: 'SELECT useraction.name, count(*) FROM useraction GROUP BY useraction.name', 'SELECT userSession.country, AVG(userSession.duration) FROM usersession WHERE ...'. Returns rows as flat objects (column-oriented response flattened). Read-only.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("USQL query string. Same syntax as the Dynatrace USQL tab in the UI."),
        startTimestamp: z
          .number()
          .int()
          .optional()
          .describe("Optional start time as Unix ms. Defaults to 'now-2h' equivalent per cluster default."),
        endTimestamp: z
          .number()
          .int()
          .optional()
          .describe("Optional end time as Unix ms. Defaults to 'now'."),
        explain: z
          .boolean()
          .optional()
          .describe("If true, returns the query plan instead of results. Useful for performance debugging."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max rows per page."),
      },
    },
    async ({ query, startTimestamp, endTimestamp, explain, pageSize }) => {
      try {
        const resp = await client.get<{
          extrapolationLevel?: number;
          columnNames?: string[];
          values?: unknown[][];
          nextKey?: string;
        }>("/api/v1/userSessionQueryLanguage/table", {
          query: {
            query,
            startTimestamp,
            endTimestamp,
            explain,
            pageSize,
          },
        });

        const columnNames = resp.columnNames ?? [];
        const valuesMatrix = resp.values ?? [];
        const rows = valuesMatrix.map((row) => {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < columnNames.length; i++) {
            const col = columnNames[i];
            if (col !== undefined) obj[col] = row[i];
          }
          return obj;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    query,
                    rowCount: rows.length,
                    extrapolationLevel: resp.extrapolationLevel,
                    nextKey: resp.nextKey ?? null,
                  },
                  columnNames,
                  rows,
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
