import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateDashboardPayload } from "./validate-dashboard-metrics.js";
import { validateDashboardTiles } from "../helpers/dashboard-tile-validate.js";

const TOOL = "dt_update_dashboard";

/**
 * PUT /api/config/v1/dashboards/{id} — full replacement of an existing dashboard.
 * Same metric pre-validation as dt_create_dashboard.
 */
export function registerUpdateDashboard(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Update an existing Config v1 dashboard (PUT /api/config/v1/dashboards/{id}). FULL REPLACEMENT — the payload must be complete, not a patch. Pre-checks: tile-type allow-list + required fields [validateTiles], metric refs [validateMetrics], MZ refs. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with WriteConfig scope. Audited. The body's 'id' field must match dashboardId.",
      inputSchema: {
        dashboardId: z.string().min(1).describe("The id of the dashboard to update."),
        dashboard: z
          .object({
            id: z.string().min(1).describe("Must equal dashboardId."),
            dashboardMetadata: z.record(z.string(), z.unknown()),
            tiles: z.array(z.record(z.string(), z.unknown())),
          })
          .passthrough(),
        validateTiles: z
          .boolean()
          .optional()
          .describe(
            "Default true. Tile-type allow-list + required-field check. Catches typos that silently render empty tiles."
          ),
        validateMetrics: z
          .boolean()
          .optional()
          .describe(
            "Default true. Pre-flight check: GET /api/v2/metrics/{key} for every metric referenced in the tiles. Set false to skip."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ dashboardId, dashboard, validateTiles, validateMetrics, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      if (dashboard.id !== dashboardId) {
        return {
          content: [
            {
              type: "text",
              text: `refused: dashboard.id (${dashboard.id}) must match dashboardId (${dashboardId})`,
            },
          ],
          isError: true,
        };
      }

      // Tile-type check (cheap, local).
      const doTileCheck = validateTiles !== false;
      if (doTileCheck) {
        const t = validateDashboardTiles(dashboard);
        if (!t.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "PUT",
            path: `/api/config/v1/dashboards/${dashboardId} (tile-check refused)`,
            validateOnly: true,
            objectId: dashboardId,
            status: "error",
            requestBody: { tileValidation: t },
            error: "tile validation failed",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    updated: false,
                    refused: true,
                    reason:
                      "tile validation failed — at least one tile has an unknown tileType (typo?) or is missing required fields. Set validateTiles:false to override.",
                    tileValidation: t,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      const doValidate = validateMetrics !== false;
      if (doValidate) {
        const v = await validateDashboardPayload(client, dashboard);
        if (!v.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "PUT",
            path: `/api/config/v1/dashboards/${dashboardId} (pre-check refused)`,
            validateOnly: true,
            objectId: dashboardId,
            status: "error",
            requestBody: { validation: v },
            error: "payload validation failed",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    updated: false,
                    refused: true,
                    reason:
                      "payload validation failed — update would have broken references. Set validateMetrics:false to override.",
                    validation: v,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      const encoded = encodeURIComponent(dashboardId);
      try {
        const { status, path, data } = await client.put<unknown>(
          TOOL,
          `/api/config/v1/dashboards/${encoded}`,
          dashboard
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "PUT",
          path,
          validateOnly: false,
          objectId: dashboardId,
          status,
          requestBody: dashboard,
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  updated: true,
                  status,
                  validatedTiles: doTileCheck,
                  validatedMetrics: doValidate,
                  response: data,
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
            validateOnly: false,
            objectId: dashboardId,
            status: err.status,
            requestBody: dashboard,
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
