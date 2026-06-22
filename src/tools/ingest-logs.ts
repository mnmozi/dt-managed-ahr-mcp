import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateLogRecords } from "../helpers/ingest-validate.js";

const TOOL = "dt_ingest_logs";

/**
 * POST /api/v2/logs/ingest — synthesize log records directly into Dynatrace.
 *
 * Each record is a flat JSON object. Recognized fields:
 *   - `content`       — the log line (required)
 *   - `timestamp`     — ISO 8601 or Unix-ms; defaults to ingest time
 *   - `severity` / `loglevel` / `status` — severity buckets (INFO / WARN / ERROR)
 *   - `host.name`, `dt.entity.host`, `dt.source_entity`, `container.name`,
 *     `process.technology`, `k8s.namespace.name`, `service.name`,
 *     `trace_id`, `span_id`, … — any attribute key the DPP rules expect
 *
 * The closing-the-loop test for log-event rules:
 *   1. dt_ingest_logs with `content: "payment failed: timeout"` +
 *      `container.name: "7orr-notifications"` + `level: "ERROR"`
 *   2. dt_search_logs with `container.name="7orr-notifications"` to confirm
 *      it landed with the expected extracted attributes
 *   3. If your custom DPP rule (or log-event rule) fired, confirm via the
 *      Logs UI or by checking problems/events
 */
export function registerIngestLogs(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Inject log records directly into Dynatrace (POST /api/v2/logs/ingest). Each record is a flat JSON object with at minimum 'content'; everything else is attributes the DPP / log-event rules can match on. The cleanest way to test log-event rules without app traffic. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with logs.ingest scope. Audited.",
      inputSchema: {
        records: z
          .array(
            z
              .object({
                content: z.string().min(1).describe("The log line text."),
                timestamp: z
                  .union([z.string(), z.number()])
                  .optional()
                  .describe("ISO 8601 string or Unix-millisecond epoch. Defaults to ingest time."),
              })
              .passthrough()
          )
          .min(1)
          .max(1000)
          .describe("Array of log records. Up to 1000 per call. Pass extra attribute keys/values via passthrough."),
        skipValidate: z
          .boolean()
          .optional()
          .describe(
            "If true, skip pre-validation of records. Default false — pre-validate catches missing content / bad timestamps / unrecognized severities before posting."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ records, skipValidate, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }

      // Pre-validate (default on). Errors → refuse. Warnings are echoed to
      // the caller in the success response.
      let warnings: ReturnType<typeof validateLogRecords>["warnings"] = [];
      if (!skipValidate) {
        const v = validateLogRecords(records as Array<Record<string, unknown>>);
        if (!v.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ingested: false,
                    refused: true,
                    reason: `pre-validate found ${v.errors.length} error(s) across the log records. Fix or pass skipValidate:true to bypass.`,
                    errors: v.errors,
                    warnings: v.warnings,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        warnings = v.warnings;
      }

      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/v2/logs/ingest",
          records
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: { recordCount: records.length, firstRecordPreview: records[0] },
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ingested: true,
                  status,
                  recordCount: records.length,
                  warnings: warnings.length > 0 ? warnings : undefined,
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
            requestBody: { recordCount: records.length, firstRecordPreview: records[0] },
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ingested: false, status: err.status, error: err.body },
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
