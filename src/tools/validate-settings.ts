import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateSettingsBatch } from "../helpers/settings-validate.js";

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
        "Dry-run one or more Settings 2.0 object payloads against Dynatrace. No side effects. Returns per-item results: invalidItems[] lists each failing item by index with Dynatrace's constraint violations and, for known opaque messages (schema not on Managed / needs DPS / not advertised, scope type not allowed), a plain-language hint. validated is true only if EVERY item passes. Requires DT_WRITE_TOKEN. Prefer this BEFORE every create.",
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
      const outcome = await validateSettingsBatch(client, TOOL, body);

      if (outcome.kind === "transport") {
        return {
          content: [{ type: "text", text: JSON.stringify({ validated: false, error: outcome.message }, null, 2) }],
          isError: true,
        };
      }
      const ok = outcome.kind === "items" && outcome.invalid.length === 0;
      audit.write({
        timestamp: new Date().toISOString(),
        tool: TOOL,
        method: "POST",
        path: "/api/v2/settings/objects?validateOnly=true",
        validateOnly: true,
        status: outcome.status,
        requestBody: body,
        ...(outcome.kind === "items"
          ? { responseBody: outcome.items }
          : { error: outcome.body }),
      });

      const payload =
        outcome.kind === "items"
          ? {
              validated: ok,
              status: outcome.status,
              validItems: body.length - outcome.invalid.length,
              invalidItems: outcome.invalid,
              ...(ok ? { response: outcome.items } : {}),
            }
          : { validated: false, status: outcome.status, error: outcome.body.slice(0, 2000) };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        ...(ok ? {} : { isError: true }),
      };
    }
  );
}
