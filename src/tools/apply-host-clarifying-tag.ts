import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { refuse } from "../helpers/tool-result.js";
import { applyNamingDecisions } from "../helpers/apply-naming-decisions.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";

const TOOL = "dt_apply_host_clarifying_tag";

/**
 * dt_apply_host_clarifying_tag — applies operator-approved naming
 * decisions to HOSTs by writing a `name:<chosenName>` tag on each host.
 * Hosts can't be renamed via the Dynatrace API (the displayName is
 * computed from cloud + DNS data), so tagging is the practical way to
 * make name-based downstream rules reliable.
 *
 * Same shell as dt_apply_pg_naming_rule — both delegate to the shared
 * applyNamingDecisions helper. Lattice rules are identical: AI cannot
 * upgrade a bucket or invent names.
 *
 * Workflow:
 *   1. Operator runs dt_audit_host_naming → gets reports[]
 *   2. Operator (and/or AI) picks names per report → builds decisions[]
 *   3. Operator calls THIS tool with both arrays + confirm:"yes"
 *   4. Lattice validation, then per-entity tag write + audit.
 */
export function registerApplyHostClarifyingTag(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Apply approved naming decisions to hosts by writing a 'name:<chosenName>' tag on each host. Tag-based because the host displayName isn't directly editable via API. Inputs are the decisions[] array plus the engine reports[] from dt_audit_host_naming (so we can validate each decision against the engine's bucket + candidates). Each decision has source: 'engine_high' (auto-pick for high_confidence) | 'ai_proposed' (AI picks from candidates for ambiguous, requires aiRationale) | 'operator_confirmed' (operator picks from candidates) | 'operator_override' (operator supplies any name, loudly logged). Lattice enforced in code. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with entities.write scope. Audited per-entity with full namingDecision provenance.",
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
            "The engine reports from the most recent dt_audit_host_naming call. Required for lattice validation."
          ),
        decisions: z
          .array(
            z.object({
              entityId: z.string().min(1).describe("HOST id this decision applies to."),
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
            "The naming decisions to apply. One per host. Each is validated against the matching report before any write."
          ),
        confirm: z.literal("yes"),
      },
    },
    async ({ reports, decisions, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      return applyNamingDecisions({
        client,
        audit,
        tool: TOOL,
        reports: reports as EntityNamingReport[],
        decisions,
      });
    }
  );
}
