import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { refuse } from "../helpers/tool-result.js";
import { applyNamingDecisions } from "../helpers/apply-naming-decisions.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";

const TOOL = "dt_apply_service_clarifying_tag";

/**
 * dt_apply_service_clarifying_tag — applies operator-approved naming
 * decisions to SERVICEs by writing a `name:<chosenName>` tag on each.
 * Renaming a service properly is a Settings 2.0 service-naming rule; the
 * tag route is reversible and schema-stable, and downstream tag rules can
 * match `tag(name:bookings)` immediately. Same shell as the PG and host
 * apply tools — all three delegate to the shared applyNamingDecisions
 * helper, so the lattice rules are identical.
 */
export function registerApplyServiceClarifyingTag(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Apply approved naming decisions to services. Writes a reversible 'name:<chosenName>' tag on each service (does NOT change display names by itself). Pass createNamingRule:true to ALSO create Config v1 conditional-naming rules keyed on the tag — the actual display rename; existing rules with the same nameFormat are skipped. Inputs are the decisions[] array plus the engine reports[] from dt_audit_service_naming (lattice validation against the engine's bucket + candidates). Each decision has source: 'engine_high' | 'ai_proposed' (requires aiRationale, names ONLY from engine candidates) | 'operator_confirmed' | 'operator_override' (loudly logged). AI cannot upgrade a bucket or invent names. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with entities.write scope. Audited per-entity with full namingDecision provenance.",
      inputSchema: {
        reports: z
          .array(
            z.object({
              entityId: z.string().min(1),
              entityType: z.string().min(1),
              currentName: z.string(),
              genericReason: z.string(),
              candidates: z.array(
                z.object({
                  source: z.string(),
                  name: z.string(),
                  confidence: z.number(),
                  evidence: z.string(),
                })
              ),
              topCandidate: z.string().optional(),
              decision: z.enum(["high_confidence", "ambiguous", "no_signal"]),
            })
          )
          .min(1)
          .describe(
            "The engine reports from the most recent dt_audit_service_naming call. Required for lattice validation."
          ),
        decisions: z
          .array(
            z.object({
              entityId: z.string().min(1).describe("SERVICE id this decision applies to."),
              chosenName: z.string().min(1).describe("The name to write as the 'name:<value>' tag."),
              source: z.enum([
                "engine_high",
                "ai_proposed",
                "operator_confirmed",
                "operator_override",
              ]),
              aiRationale: z
                .string()
                .optional()
                .describe("Required when source='ai_proposed'. 1-2 sentences explaining the pick."),
            })
          )
          .min(1)
          .describe(
            "The naming decisions to apply. One per service. Each is validated against the matching report before any write."
          ),
        createNamingRule: z
          .boolean()
          .optional()
          .describe(
            "If true, after tagging also create one Config v1 conditional-naming rule per distinct chosen name (POST /api/config/v1/conditionalNaming/) — the real display rename, keyed on the name tag. Dedupes against existing rules by nameFormat. Default false."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ reports, decisions, createNamingRule, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return applyNamingDecisions({
        client,
        audit,
        tool: TOOL,
        reports: reports as EntityNamingReport[],
        decisions,
        createNamingRule,
        conditionalNamingType: "service",
      });
    }
  );
}
