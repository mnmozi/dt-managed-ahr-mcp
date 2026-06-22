import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";

/**
 * Problem write actions. Dynatrace has no formal "acknowledge" endpoint —
 * comments serve that purpose. Convention is to comment with context tagging
 * the user/team that took the problem.
 */

const TOOL_CLOSE = "dt_close_problem";
const TOOL_COMMENT = "dt_comment_problem";

export function registerCloseProblem(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_CLOSE,
    {
      description:
        "Close a problem (POST /api/v2/problems/{id}/close). Optionally include a closing message. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with problems.write scope. Audited.",
      inputSchema: {
        problemId: z.string().min(1).describe("Problem id to close."),
        message: z
          .string()
          .optional()
          .describe("Optional closing message recorded against the problem."),
        confirm: z.literal("yes"),
      },
    },
    async ({ problemId, message, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      const encoded = encodeURIComponent(problemId);
      const body: Record<string, unknown> = {};
      if (message !== undefined) body.message = message;
      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL_CLOSE,
          `/api/v2/problems/${encoded}/close`,
          body
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL_CLOSE,
          method: "POST",
          path,
          validateOnly: false,
          objectId: problemId,
          status,
          requestBody: body,
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ closed: true, status, problemId, response: data }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL_CLOSE,
            method: "POST",
            path: err.path,
            validateOnly: false,
            objectId: problemId,
            status: err.status,
            requestBody: body,
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { closed: false, status: err.status, error: err.body },
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

export function registerCommentProblem(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_COMMENT,
    {
      description:
        "Add a comment to a problem (POST /api/v2/problems/{id}/comments). Use this for ack/triage notes — Dynatrace has no formal ack endpoint, comments serve that role. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with problems.write scope. Audited.",
      inputSchema: {
        problemId: z.string().min(1).describe("Problem id to comment on."),
        message: z.string().min(1).describe("Comment text."),
        context: z
          .string()
          .optional()
          .describe(
            "Optional short context tag (e.g. 'ack-by-ops', 'on-call-alice'). Surfaces alongside the comment in the UI."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ problemId, message, context, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      const encoded = encodeURIComponent(problemId);
      const body: Record<string, unknown> = { message };
      if (context !== undefined) body.context = context;
      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL_COMMENT,
          `/api/v2/problems/${encoded}/comments`,
          body
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL_COMMENT,
          method: "POST",
          path,
          validateOnly: false,
          objectId: problemId,
          status,
          requestBody: body,
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ commented: true, status, problemId, response: data }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL_COMMENT,
            method: "POST",
            path: err.path,
            validateOnly: false,
            objectId: problemId,
            status: err.status,
            requestBody: body,
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { commented: false, status: err.status, error: err.body },
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
