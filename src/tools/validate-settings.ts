import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";

const TOOL = "dt_validate_settings";

/**
 * Dry-run a Settings 2.0 write. POST /api/v2/settings/objects?validateOnly=true.
 * No side effects — Dynatrace returns validation errors or success metadata.
 * Does NOT require a confirm arg.
 */
export function registerValidateSettings(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Dry-run one or more Settings 2.0 object payloads against Dynatrace. No side effects. Returns the server's validation response so you can fix the payload before calling dt_create_settings. Requires DT_WRITE_TOKEN. Prefer this BEFORE every create.",
      inputSchema: {
        objects: z
          .array(
            z.object({
              schemaId: z.string().min(1),
              scope: z
                .string()
                .min(1)
                .describe(
                  "Scope the object applies to (e.g. 'environment', a host group id, an entity id)."
                ),
              value: z
                .record(z.string(), z.unknown())
                .describe("The payload matching the schema's structure."),
            })
          )
          .min(1)
          .describe("Array of settings-object payloads to validate."),
      },
    },
    async ({ objects }) => {
      const body = objects.map((o) => ({
        schemaId: o.schemaId,
        scope: o.scope,
        value: o.value,
      }));
      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/v2/settings/objects",
          body,
          { query: { validateOnly: true } }
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: true,
          status,
          requestBody: body,
          responseBody: data,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ validated: true, status, response: data }, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: err.path,
            validateOnly: true,
            status: err.status,
            requestBody: body,
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { validated: false, status: err.status, error: err.body },
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
