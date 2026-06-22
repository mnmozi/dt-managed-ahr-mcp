import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";

const TOOL = "dt_post_event";

/**
 * dt_post_event — POST /api/v2/events/ingest
 *
 * Inject an event into Dynatrace. The single best way to test alerting rules,
 * MZ propagation, problem grouping, etc. without needing real app traffic.
 *
 * Required:
 *   - eventType: one of the Dynatrace event types
 *       'CUSTOM_INFO' | 'CUSTOM_ANNOTATION' | 'CUSTOM_CONFIGURATION' |
 *       'CUSTOM_DEPLOYMENT' | 'MARKED_FOR_TERMINATION' |
 *       'ERROR_EVENT' | 'AVAILABILITY_EVENT' | 'PERFORMANCE_EVENT' |
 *       'RESOURCE_CONTENTION_EVENT'
 *   - title: short event title
 *
 * Targeting (provide at least one):
 *   - entitySelector: 'type(SERVICE),entityId(SERVICE-ABC)'
 *   - properties.dt.event.attach_rules / dt.event.scope etc.
 *
 * Optional:
 *   - startTime / endTime (epoch ms)
 *   - properties: free-form Record<string,string>
 *   - description: longer text
 *
 * Returns Dynatrace's event ingest response (eventIngestResults[] with statuses).
 */
export function registerPostEvent(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Inject an event into Dynatrace (POST /api/v2/events/ingest). Best way to test alerting / MZ propagation / problem grouping without real traffic. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with events.ingest scope. Audited.",
      inputSchema: {
        eventType: z
          .enum([
            "CUSTOM_INFO",
            "CUSTOM_ANNOTATION",
            "CUSTOM_CONFIGURATION",
            "CUSTOM_DEPLOYMENT",
            "MARKED_FOR_TERMINATION",
            "ERROR_EVENT",
            "AVAILABILITY_EVENT",
            "PERFORMANCE_EVENT",
            "RESOURCE_CONTENTION_EVENT",
          ])
          .describe(
            "Event type. CUSTOM_INFO / CUSTOM_ANNOTATION don't open problems; ERROR_EVENT / AVAILABILITY_EVENT / PERFORMANCE_EVENT / RESOURCE_CONTENTION_EVENT can open problems if AD rules match."
          ),
        title: z.string().min(1).describe("Short event title."),
        description: z.string().optional().describe("Longer description text."),
        entitySelector: z
          .string()
          .optional()
          .describe(
            "Entity selector to scope the event. Examples: 'type(SERVICE),entityId(SERVICE-ABC)', 'type(HOST),tag(env:prod)'."
          ),
        startTime: z.number().int().optional().describe("Epoch ms. Default: ingest time at the server."),
        endTime: z.number().int().optional().describe("Epoch ms. For events with duration."),
        properties: z
          .record(z.string(), z.string())
          .optional()
          .describe("Free-form Record<string,string>. Surface in the UI under Event properties."),
        timeout: z.number().int().optional().describe("Auto-close timeout in minutes (event types that open problems)."),
        confirm: z.literal("yes"),
      },
    },
    async ({ eventType, title, description, entitySelector, startTime, endTime, properties, timeout, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      const body: Record<string, unknown> = {
        eventType,
        title,
      };
      if (description !== undefined) body.description = description;
      if (entitySelector !== undefined) body.entitySelector = entitySelector;
      if (startTime !== undefined) body.startTime = startTime;
      if (endTime !== undefined) body.endTime = endTime;
      if (timeout !== undefined) body.timeout = timeout;
      if (properties !== undefined) body.properties = properties;

      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/v2/events/ingest",
          body
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: body,
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ posted: true, status, response: data }, null, 2),
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
            requestBody: body,
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { posted: false, status: err.status, error: err.body },
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
