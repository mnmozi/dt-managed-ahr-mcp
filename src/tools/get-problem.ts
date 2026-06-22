import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * GET /api/v2/problems/{problemId}
 *
 * Companion to dt_get_problem_history (which lists+analyses). This is the
 * single-problem detail view — affected entities, root cause analysis,
 * impact analysis, comments, status, severity.
 */
export function registerGetProblem(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_problem",
    {
      description:
        "Get one problem's full detail by id (GET /api/v2/problems/{id}). Returns status, severity, affected entities, root cause analysis, impact entities, comments, evidence details. Companion to dt_get_problem_history (which is the list/analysis view).",
      inputSchema: {
        problemId: z
          .string()
          .min(1)
          .describe(
            "Problem id, e.g. '-3478299729571220858_1700000000000V2'. Get this from dt_get_problem_history or the UI."
          ),
        fields: z
          .string()
          .optional()
          .describe(
            "Optional fields projection (comma-separated). Examples: '+evidenceDetails', '+impactAnalysis', '+recentComments'. Default: returns the standard summary."
          ),
      },
    },
    async ({ problemId, fields }) => {
      const encoded = encodeURIComponent(problemId);
      try {
        const data = await client.get<unknown>(`/api/v2/problems/${encoded}`, {
          query: { fields },
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
