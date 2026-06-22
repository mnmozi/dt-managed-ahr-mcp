import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  generateRemediation,
  type RemediationSelector,
} from "../helpers/hostgroup-remediation.js";
import type { HostGroupsCoverageAuditOutput } from "../engine/analyzers/hostgroups-coverage-audit.js";

/**
 * dt_export_hostgroup_remediation — generates oneagentctl shell commands
 * for the findings the operator chose to act on. Pure text generation;
 * no Dynatrace API calls.
 *
 * Workflow:
 *   1. dt_audit_host_groups → returns findings (5 categories)
 *   2. Operator (or AI working with operator) picks which to act on
 *      via the `accept` selector
 *   3. THIS tool returns:
 *        - per-host oneagentctl commands
 *        - optional Ansible inventory fragment for batch execution
 *        - estimated downtime + counts
 *
 * The operator (or their config-management pipeline) executes the
 * commands. The MCP never runs them — we don't have SSH credentials and
 * an LLM-initiated remote command is exactly the kind of thing this
 * codebase refuses on principle.
 *
 * No DtClient needed — pass-through to the local helper.
 */
export function registerExportHostgroupRemediation(server: McpServer): void {
  server.registerTool(
    "dt_export_hostgroup_remediation",
    {
      description:
        "Generate oneagentctl shell commands for the host-group findings the operator chose to act on. Inputs: (1) the audit output from dt_audit_host_groups; (2) an 'accept' selector picking which hostsWithoutGroup entries (by hostId, with optional assignToGroup override) and splitFleets (by fleetKey) to remediate. Returns per-host commands, an Ansible inventory fragment (when ≥ 2 hosts), and a summary. NO Dynatrace API calls — pure text generation. The operator (or their config-management tool) runs the commands. Picking a splitFleet remediates every host that needs reassignment in that fleet; picking a hostsWithoutGroup adds a command for that single host.",
      inputSchema: {
        audit: z
          .object({
            hostsWithoutGroup: z.array(z.record(z.string(), z.unknown())),
            splitFleets: z.array(z.record(z.string(), z.unknown())),
            singleMemberLikelyTypos: z.array(z.record(z.string(), z.unknown())),
            genericGroupNames: z.array(z.record(z.string(), z.unknown())),
            namingDrift: z.array(z.record(z.string(), z.unknown())),
            counts: z.record(z.string(), z.unknown()),
            appliedDefaults: z.record(z.string(), z.unknown()),
          })
          .passthrough()
          .describe(
            "The full output object from the most recent dt_audit_host_groups call. Pass it back verbatim."
          ),
        accept: z
          .object({
            hostsWithoutGroup: z
              .array(
                z.object({
                  hostId: z.string().min(1),
                  assignToGroup: z
                    .string()
                    .optional()
                    .describe(
                      "Override the engine's fleetSuggestion (or supply one when there is none)."
                    ),
                })
              )
              .optional(),
            splitFleets: z
              .array(z.string().min(1))
              .optional()
              .describe(
                "Array of fleetKeys (from audit.splitFleets[].fleetKey) to remediate."
              ),
          })
          .describe(
            "Selector: which findings to act on. Unselected findings are ignored. Unmatched selector entries are surfaced in unmatchedSelectors[] so the caller can fix the call."
          ),
      },
    },
    async ({ audit, accept }) => {
      const out = generateRemediation(
        audit as unknown as HostGroupsCoverageAuditOutput,
        accept as RemediationSelector
      );
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );
}
