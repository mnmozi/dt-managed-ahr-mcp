import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { safeDelete } from "../helpers/safe-delete.js";
import { refuse } from "../helpers/tool-result.js";

const TOOL = "dt_delete_settings";

/**
 * SchemaIds whose objects have very large blast radius — losing one is a
 * significant operational event. For these, we REQUIRE expectedName on top
 * of expectedSchemaId so the caller proves they fetched the object first.
 *
 * Curated, not exhaustive — extend as we encounter more high-blast schemas.
 */
const HIGH_BLAST_SCHEMA_IDS = new Set<string>([
  "builtin:alerting.profile",
  "builtin:management-zones",
  "builtin:problem.notifications",
  "builtin:tags.auto-tagging",
  "builtin:anomaly-detection.metric-events",
  "builtin:span-event-extraction",
  "builtin:logmonitoring.log-events",
  "builtin:opentelemetry-metrics",
]);

/**
 * DELETE /api/v2/settings/objects/{objectId} — remove a Settings 2.0 object.
 *
 * Safety nets on top of confirm='yes':
 *  - `expectedSchemaId` check: the prior object's schemaId must match
 *  - `expectedName`: REQUIRED for high-blast-radius schemas (alerting
 *    profile, MZ, problem notifications, auto-tag rule, …)
 *  - prior body captured in audit log (reversible via dt_create_settings)
 *
 * Pass `force: true` AND `acknowledgeForce: true` to skip the pre-fetch.
 */
export function registerDeleteSettings(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Delete a Settings 2.0 object by objectId (DELETE /api/v2/settings/objects/{id}). Fetches the object first, confirms its schemaId matches expectedSchemaId, and stores the full prior value in the audit log so the deletion is reversible. For HIGH-BLAST-RADIUS schemas (alerting profile, management zone, problem notifications, auto-tag rules, metric events, …) expectedName is ALSO required. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with settings.write scope.",
      inputSchema: {
        objectId: z.string().min(1).describe("The objectId to delete."),
        expectedSchemaId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The schemaId you expect this object to belong to. Strongly recommended — guards against deleting the wrong object when ids look similar."
          ),
        expectedName: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Required when expectedSchemaId is on the high-blast-radius list (alerting profile, MZ, problem notifications, auto-tag rule, …). The prior object's name/summary/displayName field must match."
          ),
        force: z
          .boolean()
          .optional()
          .describe("Skip the pre-fetch + sanity checks. Default false. Requires acknowledgeForce:true."),
        acknowledgeForce: z
          .boolean()
          .optional()
          .describe(
            "Required companion to force:true. Without it, force is rejected. Skipping pre-fetch also skips the reversible-audit capture."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ objectId, expectedSchemaId, expectedName, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");

      // High-blast-radius schemas require expectedName even before we hit
      // safeDelete (so the refusal is loud and obvious).
      if (
        expectedSchemaId &&
        HIGH_BLAST_SCHEMA_IDS.has(expectedSchemaId) &&
        !expectedName &&
        !force
      ) {
        return refuse(
          `schemaId '${expectedSchemaId}' is on the high-blast-radius list — expectedName is required so we can verify the prior object matches before deleting. (Fetch it first with dt_get_settings_object.)`
        );
      }

      const encoded = encodeURIComponent(objectId);
      return safeDelete({
        client,
        audit,
        tool: TOOL,
        fetchPath: `/api/v2/settings/objects/${encoded}`,
        deletePath: `/api/v2/settings/objects/${encoded}`,
        objectId,
        force,
        acknowledgeForce,
        sanityCheck: (prior) => {
          if (expectedSchemaId) {
            const priorSchemaId = (prior as { schemaId?: string } | null)?.schemaId;
            if (priorSchemaId && priorSchemaId !== expectedSchemaId) {
              return `schemaId mismatch — object's schemaId is '${priorSchemaId}' but caller expected '${expectedSchemaId}'`;
            }
          }
          if (expectedName) {
            const value = (prior as { value?: Record<string, unknown> } | null)?.value ?? {};
            const priorName =
              (typeof value["name"] === "string" && (value["name"] as string)) ||
              (typeof value["summary"] === "string" && (value["summary"] as string)) ||
              (typeof value["displayName"] === "string" && (value["displayName"] as string)) ||
              null;
            if (priorName && priorName !== expectedName) {
              return `name mismatch — object's name is '${priorName}' but caller expected '${expectedName}'`;
            }
            if (!priorName) {
              return `expectedName='${expectedName}' was provided but the prior object has no name/summary/displayName field to compare against. Pass force+acknowledgeForce if you really want to skip the check.`;
            }
          }
          return null;
        },
        priorBodyKey: "priorObject",
        notFoundLabel: "object",
        reversibleHint:
          "audit log entry contains priorObject — re-create with dt_create_settings using its value",
        extraSuccess: (prior) => ({
          schemaId: (prior as { schemaId?: string } | null)?.schemaId ?? expectedSchemaId,
        }),
      });
    }
  );
}
