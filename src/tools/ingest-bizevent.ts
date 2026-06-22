import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateBizevents } from "../helpers/ingest-validate.js";

const TOOL = "dt_ingest_bizevent";

/**
 * POST /api/v2/bizevents/ingest — push business events into Dynatrace.
 *
 * Two encodings:
 *   - "default" — application/json — body is a single bizevent object or an
 *     array of them. Each object must include at least `event.type` and
 *     `event.provider`; everything else is free-form attributes.
 *   - "cloudevent" — application/cloudevent+json — CloudEvents v1.0 shape
 *     ({ id, source, type, specversion, data }). Use this if your producer
 *     speaks the CloudEvents standard.
 *
 * Bizevents bypass DDU metric/log billing — they're billed under their own
 * category and are designed for high-value business signal (orders, payments,
 * conversions). Don't synthesize at high rates without checking the consumption.
 */
export function registerIngestBizevent(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Push business events to Dynatrace (POST /api/v2/bizevents/ingest). Supports default JSON encoding (bizevent object/array with at minimum 'event.type' + 'event.provider') or CloudEvents v1.0 encoding. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with bizevents.ingest scope. Audited.",
      inputSchema: {
        encoding: z
          .enum(["default", "cloudevent"])
          .optional()
          .describe("Content-Type to send. 'default' = application/json. 'cloudevent' = application/cloudevent+json. Default 'default'."),
        events: z
          .union([
            z.record(z.string(), z.unknown()),
            z.array(z.record(z.string(), z.unknown())),
          ])
          .describe(
            "One bizevent object or an array of them. Default encoding requires at least 'event.type' and 'event.provider' fields per event. CloudEvents encoding requires id/source/type/specversion/data."
          ),
        skipValidate: z
          .boolean()
          .optional()
          .describe(
            "If true, skip pre-validation. Default false — pre-validate catches missing event.type/event.provider (default encoding) or missing CloudEvents fields before posting."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ encoding, events, skipValidate, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      const contentType =
        encoding === "cloudevent" ? "application/cloudevent+json" : "application/json";
      const eventList = Array.isArray(events) ? events : [events];
      const eventCount = eventList.length;

      // Pre-validate (default on). Errors → refuse; warnings are surfaced on success.
      let warnings: ReturnType<typeof validateBizevents>["warnings"] = [];
      if (!skipValidate) {
        const v = validateBizevents(eventList, encoding ?? "default");
        if (!v.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ingested: false,
                    refused: true,
                    reason: `pre-validate found ${v.errors.length} error(s). Bizevents missing event.type/event.provider are silently dropped. Fix or pass skipValidate:true to bypass.`,
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
          "/api/v2/bizevents/ingest",
          events,
          { contentType }
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: { encoding: contentType, eventCount, firstEventPreview: Array.isArray(events) ? events[0] : events },
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
                  eventCount,
                  encoding: contentType,
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
            requestBody: { encoding: contentType, eventCount },
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
