import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { refuse } from "../helpers/tool-result.js";
import { applyNamingDecisions } from "../helpers/apply-naming-decisions.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";

const TOOL = "dt_apply_pg_naming_rule";

/**
 * dt_apply_pg_naming_rule — applies operator-approved naming decisions
 * to process groups by writing a `name:<chosenName>` tag on each PG.
 * Downstream tag-strategy rules can then match `tag(name:orders-api)`
 * even though the PG's display name is still "java".
 *
 * The actual validate-and-write loop lives in
 * helpers/apply-naming-decisions.ts (shared with dt_apply_host_clarifying_tag);
 * this file is the input-schema + tool-registration shell.
 *
 * Workflow:
 *   1. Operator runs dt_audit_process_group_naming → gets reports[]
 *   2. Operator (and/or AI) picks names per report → builds decisions[]
 *   3. Operator calls THIS tool with both arrays + confirm:"yes"
 *   4. Each decision is lattice-validated against its matching report.
 *      The whole batch is refused on any lattice failure.
 *   5. Per-entity tag write + audit with namingDecision provenance.
 */
export function registerApplyPgNamingRule(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Apply approved naming decisions to process groups. Writes a reversible 'name:<chosenName>' tag on each PG (this alone does NOT change display names). Pass createNamingRule:true to ALSO create one Config v1 conditional-naming rule per distinct name (keyed on the tag) — the actual display rename; existing rules with the same nameFormat are skipped, never duplicated. Inputs are the decisions[] array plus the engine reports[] from dt_audit_process_group_naming (so we can validate each decision against the engine's bucket + candidates). Each decision has source: 'engine_high' (auto-pick for high_confidence) | 'ai_proposed' (AI picks from candidates for ambiguous, requires aiRationale) | 'operator_confirmed' (operator picks from candidates) | 'operator_override' (operator supplies any name, loudly logged). Lattice enforced in code: AI cannot upgrade a bucket or invent names. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with entities.write scope. Each write is audited with a namingDecision provenance block.",
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
            "The engine reports from the most recent dt_audit_process_group_naming call. Required for lattice validation."
          ),
        decisions: z
          .array(
            z.object({
              entityId: z.string().min(1).describe("PG id this decision applies to."),
              chosenName: z.string().min(1).describe("The name to write as the 'name:<value>' tag."),
              source: z
                .enum(["engine_high", "ai_proposed", "operator_confirmed", "operator_override"])
                .describe(
                  "Who decided. Validated against the report bucket: engine_high only valid for high_confidence; ai_proposed only valid for ambiguous and requires aiRationale; operator_override is always allowed (loudly logged)."
                ),
              aiRationale: z
                .string()
                .optional()
                .describe("Required when source='ai_proposed'. 1-2 sentences explaining the pick."),
            })
          )
          .min(1)
          .describe(
            "The naming decisions to apply. One per entity. Each decision is validated against the matching report before any write."
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
        conditionalNamingType: "processGroup",
      });
    }
  );
}
