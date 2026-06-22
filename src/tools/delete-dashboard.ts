import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { safeDelete } from "../helpers/safe-delete.js";
import { refuse } from "../helpers/tool-result.js";

const TOOL = "dt_delete_dashboard";

export function registerDeleteDashboard(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Delete a Config v1 dashboard (DELETE /api/config/v1/dashboards/{id}). Fetches the dashboard first, REQUIRES expectedName to match (high-blast-radius safety), and stores the full prior payload in the audit log so the deletion is reversible. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with WriteConfig scope.",
      inputSchema: {
        dashboardId: z.string().min(1).describe("The id of the dashboard to delete."),
        expectedName: z
          .string()
          .min(1)
          .describe(
            "REQUIRED. The dashboard's metadata.name must equal this — otherwise the tool refuses. Prevents deleting the wrong dashboard when ids look similar."
          ),
        force: z
          .boolean()
          .optional()
          .describe("Skip the pre-fetch + name check. Default false. Requires acknowledgeForce:true."),
        acknowledgeForce: z
          .boolean()
          .optional()
          .describe(
            "Required companion to force:true. Without it, force is rejected. Skipping pre-fetch also skips the reversible-audit capture."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ dashboardId, expectedName, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encoded = encodeURIComponent(dashboardId);
      return safeDelete({
        client,
        audit,
        tool: TOOL,
        fetchPath: `/api/config/v1/dashboards/${encoded}`,
        deletePath: `/api/config/v1/dashboards/${encoded}`,
        objectId: dashboardId,
        force,
        acknowledgeForce,
        sanityCheck: (prior) => {
          const priorName = (prior as { dashboardMetadata?: { name?: string } } | null)
            ?.dashboardMetadata?.name;
          if (priorName && priorName !== expectedName) {
            return `name mismatch — dashboard is named '${priorName}' but caller expected '${expectedName}'`;
          }
          return null;
        },
        priorBodyKey: "priorDashboard",
        notFoundLabel: "dashboard",
        reversibleHint:
          "audit log entry contains priorDashboard — re-create with dt_create_dashboard using its body",
        extraSuccess: (prior) => ({
          priorName:
            (prior as { dashboardMetadata?: { name?: string } } | null)?.dashboardMetadata?.name ?? null,
        }),
      });
    }
  );
}
