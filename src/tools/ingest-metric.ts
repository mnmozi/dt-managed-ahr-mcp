import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { validateMetricPoints } from "../helpers/ingest-validate.js";

const TOOL = "dt_ingest_metric";

/**
 * POST /api/v2/metrics/ingest — push numeric data points to Dynatrace in the
 * metric ingest line protocol. Accepts EITHER a structured `points` array (we
 * build the line-protocol body for you, which is the safer path) OR a raw
 * `linesText` body that we send unchanged.
 *
 * Line protocol shape:
 *   <metric.key>[,<dim>=<v>[,<dim>=<v>...]] <value> [<timestamp_ms>]
 *
 * Notes for callers:
 *  - Metric keys MUST start with a letter and may contain letters/digits/_/-/dot.
 *  - Dimension keys/values are validated server-side; high-cardinality dims
 *    (per-user-id, per-request-id) will cause Dynatrace to reject or downsample.
 *  - The endpoint accepts up to 1000 lines per request.
 *  - Setting unit/displayName/description is a SEPARATE concern — use
 *    dt_create_settings against builtin:metric.metadata for that. Ingest only
 *    creates the metric series.
 */
export function registerIngestMetric(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Push custom metric data points to Dynatrace via the v2 metric ingest line protocol (POST /api/v2/metrics/ingest). Provide either structured 'points' (preferred, safer) or raw 'linesText'. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with metrics.ingest scope. Audited. To set unit/displayName/description on a new metric, separately call dt_create_settings against builtin:metric.metadata after the first ingest.",
      inputSchema: {
        points: z
          .array(
            z.object({
              metricKey: z
                .string()
                .min(1)
                .describe(
                  "Metric key. Must start with a letter; may contain letters, digits, '_', '-', '.'."
                ),
              dimensions: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                  "Optional key/value dimension tags. Keep cardinality bounded — Dynatrace will reject or downsample high-cardinality dims."
                ),
              value: z
                .union([z.number(), z.string()])
                .describe(
                  "The data point. A bare number (gauge), or a typed prefix string like 'count,123', 'gauge,5.0', or a summary 'min=0,max=10,sum=42,count=5'."
                ),
              timestampMs: z
                .number()
                .int()
                .optional()
                .describe(
                  "Optional Unix-millisecond timestamp. Defaults to ingest time at the server."
                ),
            })
          )
          .optional()
          .describe(
            "Structured data points. The tool encodes them as line protocol. Provide this OR linesText, not both."
          ),
        linesText: z
          .string()
          .optional()
          .describe(
            "Pre-formatted line protocol body (newline-separated). Bypasses the structured encoder — use only if you know the exact protocol. NOTE: linesText skips the structured pre-validate (the validator only runs on the structured 'points' input)."
          ),
        skipValidate: z
          .boolean()
          .optional()
          .describe(
            "If true, skip pre-validation of metric keys / dimensions / values. Default false — pre-validate catches typos that Dynatrace silently rejects line-by-line (the endpoint returns 202 even on partial failure)."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ points, linesText, skipValidate, confirm }) => {
      if (confirm !== "yes") {
        return {
          content: [{ type: "text", text: "refused: confirm must be 'yes'" }],
          isError: true,
        };
      }
      if (!points && !linesText) {
        return {
          content: [{ type: "text", text: "refused: provide either 'points' or 'linesText'" }],
          isError: true,
        };
      }
      if (points && linesText) {
        return {
          content: [
            { type: "text", text: "refused: provide either 'points' or 'linesText', not both" },
          ],
          isError: true,
        };
      }

      let body: string;
      let lineCount: number;
      if (linesText) {
        body = linesText.trim();
        lineCount = body.split("\n").filter((l) => l.trim().length > 0).length;
      } else {
        // Pre-validate structured points before encoding. The endpoint returns
        // 202 even on partial failure, so this is our only chance to surface
        // bad keys / dims with a structured error instead of silent data loss.
        if (!skipValidate) {
          const v = validateMetricPoints(points ?? []);
          if (!v.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ingested: false,
                      refused: true,
                      reason: `pre-validate found ${v.errors.length} error(s) across the metric points. Dynatrace would 202 then silently drop these lines. Fix or pass skipValidate:true to bypass.`,
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
        }
        const lines = (points ?? []).map(encodePoint);
        body = lines.join("\n");
        lineCount = lines.length;
      }
      if (lineCount === 0) {
        return {
          content: [{ type: "text", text: "refused: no metric lines to send" }],
          isError: true,
        };
      }
      if (lineCount > 1000) {
        return {
          content: [
            {
              type: "text",
              text: `refused: too many lines (${lineCount}); Dynatrace accepts up to 1000 per request`,
            },
          ],
          isError: true,
        };
      }

      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/v2/metrics/ingest",
          body,
          { contentType: "text/plain; charset=utf-8" }
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: { lineCount, sample: firstLine(body) },
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ingested: true, status, lineCount, response: data },
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
            requestBody: { lineCount, sample: firstLine(body) },
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

/**
 * Encode one structured point as a line-protocol line. Dimension values are
 * quoted only when they need to be (contain spaces, commas, equals, or quotes);
 * keys aren't quoted but rejected if they look invalid.
 */
function encodePoint(p: {
  metricKey: string;
  dimensions?: Record<string, string>;
  value: number | string;
  timestampMs?: number;
}): string {
  const parts: string[] = [p.metricKey];
  if (p.dimensions) {
    const dims = Object.entries(p.dimensions)
      .map(([k, v]) => `${k}=${quoteIfNeeded(v)}`)
      .join(",");
    if (dims) parts[0] = `${p.metricKey},${dims}`;
  }
  const valueStr = typeof p.value === "number" ? String(p.value) : p.value;
  let line = `${parts[0]} ${valueStr}`;
  if (p.timestampMs !== undefined) line += ` ${p.timestampMs}`;
  return line;
}

function quoteIfNeeded(v: string): string {
  if (/[\s,="]/.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}

function firstLine(body: string): string {
  const idx = body.indexOf("\n");
  return idx === -1 ? body : body.slice(0, idx);
}
