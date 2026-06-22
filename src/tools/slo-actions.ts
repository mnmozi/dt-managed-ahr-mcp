import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { mutateAndAudit, refuse } from "../helpers/mutate-and-audit.js";
import { safeDelete } from "../helpers/safe-delete.js";

/**
 * SLOs live at /api/v2/slo on Managed — NOT in Settings 2.0.
 *
 * Required body fields:
 *   - name
 *   - target (0-100, the SLO objective %)
 *   - timeframe ('-7d', '-30d', etc.)
 *   - either metricExpression (modern) OR metricRate (legacy)
 *
 * We use .passthrough() and only enforce the required scalars — other fields
 * vary by Managed version.
 */

const TOOL_CREATE = "dt_create_slo";
const TOOL_UPDATE = "dt_update_slo";
const TOOL_DELETE = "dt_delete_slo";

const sloBody = z
  .object({
    name: z.string().min(1).describe("Display name."),
    target: z.number().min(0).max(100).describe("SLO target %, e.g. 99.9."),
    timeframe: z
      .string()
      .min(1)
      .describe("Evaluation window. Dynatrace timeframe expression: '-7d', '-30d', etc."),
    metricExpression: z
      .string()
      .optional()
      .describe(
        "Modern — a single Metric Expression resolving to success rate, e.g. '(builtin:service.successCount.total/builtin:service.requestCount.total)*(100)'."
      ),
    metricRate: z.string().optional().describe("Legacy — name of the rate metric."),
    metricNumerator: z.string().optional(),
    metricDenominator: z.string().optional(),
    filter: z.string().optional().describe("Entity selector scoping the SLO."),
    warning: z.number().min(0).max(100).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    evaluationType: z.string().optional(),
  })
  .passthrough();

export function registerCreateSlo(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    TOOL_CREATE,
    {
      description:
        "Create an SLO (POST /api/v2/slo). Required: name, target (0-100), timeframe, AND either metricExpression OR the legacy metricRate. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with slo.write scope.",
      inputSchema: { slo: sloBody, confirm: z.literal("yes") },
    },
    async ({ slo, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return mutateAndAudit({
        tool: TOOL_CREATE,
        method: "POST",
        action: () => client.post(TOOL_CREATE, "/api/v2/slo", slo),
        audit,
        requestBody: slo,
        successKey: "created",
      });
    }
  );
}

export function registerUpdateSlo(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    TOOL_UPDATE,
    {
      description:
        "Update an SLO by id (PUT /api/v2/slo/{id}). FULL REPLACEMENT. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with slo.write.",
      inputSchema: {
        sloId: z.string().min(1).describe("SLO id."),
        slo: sloBody,
        confirm: z.literal("yes"),
      },
    },
    async ({ sloId, slo, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return mutateAndAudit({
        tool: TOOL_UPDATE,
        method: "PUT",
        action: () => client.put(TOOL_UPDATE, `/api/v2/slo/${encodeURIComponent(sloId)}`, slo),
        audit,
        requestBody: slo,
        objectId: sloId,
        successKey: "updated",
      });
    }
  );
}

export function registerDeleteSlo(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    TOOL_DELETE,
    {
      description:
        "Delete an SLO by id (DELETE /api/v2/slo/{id}). Pre-fetches the SLO + optional expectedName check; prior body captured for reversibility. REQUIRES confirm='yes'.",
      inputSchema: {
        sloId: z.string().min(1).describe("SLO id."),
        expectedName: z.string().optional(),
        force: z
          .boolean()
          .optional()
          .describe("Skip pre-fetch + sanity check. Requires acknowledgeForce:true."),
        acknowledgeForce: z
          .boolean()
          .optional()
          .describe("Required companion to force:true; without it, force is rejected."),
        confirm: z.literal("yes"),
      },
    },
    async ({ sloId, expectedName, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encoded = encodeURIComponent(sloId);
      return safeDelete({
        client,
        audit,
        tool: TOOL_DELETE,
        fetchPath: `/api/v2/slo/${encoded}`,
        deletePath: `/api/v2/slo/${encoded}`,
        objectId: sloId,
        force,
        acknowledgeForce,
        sanityCheck: (prior) => {
          if (!expectedName) return null;
          const priorName = (prior as { name?: string } | null)?.name;
          if (priorName && priorName !== expectedName) {
            return `name mismatch — SLO is named '${priorName}' but caller expected '${expectedName}'`;
          }
          return null;
        },
        priorBodyKey: "priorSlo",
        notFoundLabel: "SLO",
        reversibleHint: "audit log entry contains priorSlo — re-create with dt_create_slo",
        extraSuccess: (prior) => ({
          priorName: (prior as { name?: string } | null)?.name ?? null,
        }),
      });
    }
  );
}
