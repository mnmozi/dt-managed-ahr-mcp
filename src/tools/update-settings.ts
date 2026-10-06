import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";

const TOOL = "dt_update_settings";

/**
 * PUT /api/v2/settings/objects/{objectId} — updates an existing Settings 2.0 object.
 *
 * Before a real (non-dryRun) update we GET the current object and store it
 * in the audit row as `priorObject`, so an update is as reversible as a
 * delete: re-apply the prior value with dt_update_settings. A failed
 * pre-fetch is reported in the audit row but does not block the update —
 * the caller explicitly confirmed it.
 */
export function registerUpdateSettings(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Update an existing Settings 2.0 object by objectId (PUT /api/v2/settings/objects/{id}, FULL replacement of value). The prior object is fetched first and stored in the audit log so the update is reversible. REQUIRES confirm='yes'. Set dryRun=true to validate without applying (validateOnly=true). Requires DT_WRITE_TOKEN with settings.write. Every call is audited.",
      inputSchema: {
        objectId: z.string().min(1).describe("The objectId to update."),
        value: z
          .record(z.string(), z.unknown())
          .describe("The full replacement value for the object (not a patch)."),
        confirm: z
          .literal("yes")
          .describe("Must be 'yes' to apply the update. Guards against accidental writes."),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, passes validateOnly=true — Dynatrace validates but does not persist."),
      },
    },
    async ({ objectId, value, confirm, dryRun }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      const encoded = encodeURIComponent(objectId);
      const opts = dryRun ? { query: { validateOnly: true } } : undefined;

      // Reversibility: capture the current object before overwriting it.
      let priorObject: unknown = null;
      let priorFetchError: string | undefined;
      if (!dryRun) {
        try {
          priorObject = await client.get<unknown>(`/api/v2/settings/objects/${encoded}`);
        } catch (err) {
          if (err instanceof DtApiError && err.status === 404) {
            return {
              content: [{ type: "text", text: `refused: object '${objectId}' not found (404) — nothing to update` }],
              isError: true,
            };
          }
          priorFetchError = err instanceof Error ? err.message : String(err);
        }
      }
      try {
        const { status, path, data } = await client.put<unknown>(
          TOOL,
          `/api/v2/settings/objects/${encoded}`,
          { value },
          opts
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "PUT",
          path,
          validateOnly: Boolean(dryRun),
          objectId,
          status,
          requestBody: { value, priorObject, priorFetchError },
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  updated: !dryRun,
                  validated: Boolean(dryRun),
                  status,
                  response: data,
                  reversibleVia: dryRun
                    ? undefined
                    : priorObject
                      ? "audit log entry contains priorObject — re-apply its value with dt_update_settings to roll back"
                      : `prior object could not be captured (${priorFetchError ?? "unknown"}); roll-back must come from another source`,
                },
                null,
                2
              ),
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
            tool: TOOL,
            method: "PUT",
            path: err.path,
            validateOnly: Boolean(dryRun),
            objectId,
            status: err.status,
            requestBody: { value },
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { updated: false, status: err.status, error: err.body },
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
