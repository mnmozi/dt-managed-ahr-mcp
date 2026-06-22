import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { mutateAndAudit, refuse } from "../helpers/mutate-and-audit.js";
import { safeDelete } from "../helpers/safe-delete.js";

/**
 * Synthetic monitor write actions. /api/v1/synthetic/monitors — NOT Settings 2.0.
 *
 * Two payload flavors: HTTP (script.requests[]) and BROWSER (script.events[]).
 * We don't enforce script shape — too deep and version-dependent. .passthrough().
 */

const TOOL_CREATE = "dt_create_synthetic_monitor";
const TOOL_UPDATE = "dt_update_synthetic_monitor";
const TOOL_DELETE = "dt_delete_synthetic_monitor";

const monitorBody = z
  .object({
    name: z.string().min(1),
    type: z.enum(["HTTP", "BROWSER"]),
    enabled: z.boolean(),
    frequencyMin: z.number().int().min(1),
    locations: z.array(z.string()).min(1),
    script: z.record(z.string(), z.unknown()),
    anomalyDetection: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.record(z.string(), z.unknown())).optional(),
    manuallyAssignedApps: z.array(z.string()).optional(),
  })
  .passthrough();

export function registerCreateSyntheticMonitor(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_CREATE,
    {
      description:
        "Create a synthetic monitor (POST /api/v1/synthetic/monitors). Required: name, type (HTTP|BROWSER), enabled, frequencyMin, locations[], script. REQUIRES confirm='yes'.",
      inputSchema: { monitor: monitorBody, confirm: z.literal("yes") },
    },
    async ({ monitor, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return mutateAndAudit({
        tool: TOOL_CREATE,
        method: "POST",
        action: () => client.post(TOOL_CREATE, "/api/v1/synthetic/monitors", monitor),
        audit,
        requestBody: monitor,
        successKey: "created",
      });
    }
  );
}

export function registerUpdateSyntheticMonitor(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_UPDATE,
    {
      description:
        "Update a synthetic monitor by id (PUT /api/v1/synthetic/monitors/{id}). FULL REPLACEMENT. REQUIRES confirm='yes'.",
      inputSchema: {
        monitorId: z.string().min(1),
        monitor: monitorBody,
        confirm: z.literal("yes"),
      },
    },
    async ({ monitorId, monitor, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return mutateAndAudit({
        tool: TOOL_UPDATE,
        method: "PUT",
        action: () =>
          client.put(TOOL_UPDATE, `/api/v1/synthetic/monitors/${encodeURIComponent(monitorId)}`, monitor),
        audit,
        requestBody: monitor,
        objectId: monitorId,
        successKey: "updated",
      });
    }
  );
}

export function registerDeleteSyntheticMonitor(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_DELETE,
    {
      description:
        "Delete a synthetic monitor by id (DELETE /api/v1/synthetic/monitors/{id}). Pre-fetch + optional expectedName check. REQUIRES confirm='yes'.",
      inputSchema: {
        monitorId: z.string().min(1),
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
    async ({ monitorId, expectedName, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encoded = encodeURIComponent(monitorId);
      return safeDelete({
        client,
        audit,
        tool: TOOL_DELETE,
        fetchPath: `/api/v1/synthetic/monitors/${encoded}`,
        deletePath: `/api/v1/synthetic/monitors/${encoded}`,
        objectId: monitorId,
        force,
        acknowledgeForce,
        sanityCheck: (prior) => {
          if (!expectedName) return null;
          const priorName = (prior as { name?: string } | null)?.name;
          if (priorName && priorName !== expectedName) {
            return `name mismatch — monitor is named '${priorName}' but caller expected '${expectedName}'`;
          }
          return null;
        },
        priorBodyKey: "priorMonitor",
        notFoundLabel: "monitor",
        reversibleHint:
          "audit log entry contains priorMonitor — re-create with dt_create_synthetic_monitor",
        extraSuccess: (prior) => ({
          priorName: (prior as { name?: string } | null)?.name ?? null,
        }),
      });
    }
  );
}
