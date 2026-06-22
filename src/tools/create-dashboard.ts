import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateDashboardPayload } from "./validate-dashboard-metrics.js";
import { validateDashboardTiles } from "../helpers/dashboard-tile-validate.js";
import { checkDuplicatePayload } from "../helpers/payload-fingerprint.js";

const TOOL = "dt_create_dashboard";

/**
 * POST /api/config/v1/dashboards — create a Config v1 dashboard (the "classic"
 * dashboard surface used by Data Explorer tiles on Dynatrace Managed). The
 * payload mirrors what the Data Explorer UI exports as JSON.
 *
 * BY DEFAULT validates every referenced metric key against /api/v2/metrics
 * before posting. Refuses the write if any key is missing on this tenant —
 * Dynatrace happily creates dashboards with bogus keys, and the failure
 * only surfaces as an empty tile in the UI. Pass validateMetrics=false to
 * skip the check (e.g. when you'll ingest the metric immediately after).
 */
export function registerCreateDashboard(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Create a Config v1 dashboard (POST /api/config/v1/dashboards) with Data Explorer tiles. Pre-checks: (1) tile-type allow-list + per-tile required fields (catches DATA_EXPLORE→DATA_EXPLORER typos and missing queries) [validateTiles], (2) every metric key against /api/v2/metrics [validateMetrics], (3) referenced MZ ids exist, (4) payload-fingerprint dedup [acknowledgeDuplicate]. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with WriteConfig scope. Audited.",
      inputSchema: {
        dashboard: z
          .object({
            dashboardMetadata: z
              .record(z.string(), z.unknown())
              .describe("At minimum: name (string), owner (string), shared (boolean)."),
            tiles: z
              .array(z.record(z.string(), z.unknown()))
              .describe("Tile array. Data Explorer tiles use tileType='DATA_EXPLORER'."),
          })
          .passthrough()
          .describe("Full dashboard payload matching the Config v1 dashboards schema."),
        validateTiles: z
          .boolean()
          .optional()
          .describe(
            "Default true. Pre-flight check: each tile's tileType is on the allow-list and required fields are non-empty. Catches typos that render empty tiles silently."
          ),
        validateMetrics: z
          .boolean()
          .optional()
          .describe(
            "Default true. Pre-flight check: GET /api/v2/metrics/{key} for every metric referenced in the tiles. Set false to skip — useful when the referenced metric will be ingested right after."
          ),
        acknowledgeDuplicate: z
          .boolean()
          .optional()
          .describe(
            "Required if the same dashboard payload was submitted in the last 10 minutes (typical when retrying after a timeout). Pass true to override the duplicate warning."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ dashboard, validateTiles, validateMetrics, acknowledgeDuplicate, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }

      // (1) Tile-type / required-field validation. Cheap + local.
      const doTileCheck = validateTiles !== false;
      if (doTileCheck) {
        const t = validateDashboardTiles(dashboard);
        if (!t.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: "/api/config/v1/dashboards (tile-check refused)",
            validateOnly: true,
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
                    created: false,
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

      // (2) Metric + MZ existence checks (HTTP-bound).
      const doValidate = validateMetrics !== false;
      if (doValidate) {
        const v = await validateDashboardPayload(client, dashboard);
        if (!v.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: "/api/config/v1/dashboards (pre-check refused)",
            validateOnly: true,
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
                    created: false,
                    refused: true,
                    reason:
                      "payload validation failed — dashboard would have rendered with broken references. Set validateMetrics:false to override.",
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

      // (3) Payload-fingerprint dedup.
      const dup = checkDuplicatePayload(audit, TOOL, dashboard);
      if (dup.isDuplicate && !acknowledgeDuplicate) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: false,
                  refused: true,
                  reason: dup.warning,
                  fingerprint: dup.fingerprint,
                  priorRecordTimestamp: dup.priorRecord?.timestamp,
                  priorRecordStatus: dup.priorRecord?.status,
                  note: "Pass acknowledgeDuplicate:true to proceed anyway.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/config/v1/dashboards",
          dashboard
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: dashboard,
          responseBody: data,
          payloadFingerprint: dup.fingerprint,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: true,
                  status,
                  validatedTiles: doTileCheck,
                  validatedMetrics: doValidate,
                  payloadFingerprint: dup.fingerprint,
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
            method: "POST",
            path: err.path,
            validateOnly: false,
            status: err.status,
            requestBody: dashboard,
            error: err.body,
            payloadFingerprint: dup.fingerprint,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { created: false, status: err.status, error: err.body },
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
