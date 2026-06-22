import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchNamingGraph } from "../engine/naming-graph-fetcher.js";
import { analyzeHostGroupsCoverage } from "../engine/analyzers/hostgroups-coverage-audit.js";

/**
 * dt_audit_host_groups — third read tool of the naming-hygiene pipeline.
 *
 * Audits the CONSISTENCY of host-group membership (not host-group names —
 * those are operator-chosen at OneAgent install time). Returns five
 * categories of finding:
 *
 *   - hostsWithoutGroup: hosts with no hostGroupName. Per-host fleet
 *     suggestion when fleet-mates have a dominant group.
 *   - splitFleets: hosts running the same workload (same fleetKey) but
 *     scattered across different host groups.
 *   - singleMemberLikelyTypos: 1-host groups whose name is within
 *     edit-distance 2 of a populated group (5+ members).
 *   - genericGroupNames: groups named "default" / "prod" / "linux" etc.
 *   - namingDrift: multiple groups normalizing to the same canonical
 *     name ("orders-prod" / "Orders-Prod" / "orders_prod").
 *
 * No write API on this layer — Dynatrace doesn't expose a way to change
 * host-group membership remotely. Pair this audit with
 * dt_export_hostgroup_remediation to get the oneagentctl shell commands
 * the operator runs on the affected hosts.
 *
 * Run AFTER dt_audit_host_naming so name-clarifying tags are already in
 * place; the host-group audit then operates on a tagged cluster.
 */
export function registerAuditHostGroups(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_audit_host_groups",
    {
      description:
        "Audit host-group hygiene. Detects (1) hosts with no host group, (2) split fleets — hosts running identical workload scattered across different groups, (3) single-member host groups whose name is within edit-distance 2 of a populated group (likely typos), (4) generic group names (default/prod/linux/etc.), (5) naming drift — multiple groups normalizing to the same canonical name (e.g. Orders-Prod vs orders-prod). Host-group membership can't be changed via Dynatrace API; pair with dt_export_hostgroup_remediation to generate the oneagentctl shell commands. Args: minFleetSize (default 2), maxEditDistance (default 2).",
      inputSchema: {
        minFleetSize: z
          .number()
          .int()
          .min(2)
          .max(50)
          .optional()
          .describe(
            "Smallest fleet (same fleetKey) reported as 'split'. Default 2 — below this, single-host fleets are noise."
          ),
        maxEditDistance: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Levenshtein threshold for the typo detector. Default 2 — higher values produce false positives across legitimately-different group names."
          ),
      },
    },
    async ({ minFleetSize, maxEditDistance }) => {
      try {
        const graphIn = await fetchNamingGraph(client);
        const engine = await getEngine();
        const audit = await analyzeHostGroupsCoverage(engine, {
          ...graphIn,
          minFleetSize,
          maxEditDistance,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(audit, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  available: false,
                  reason: "host-group coverage audit could not be computed",
                  error: msg,
                  hint: "Make sure DT_ENGINE_BIN is set and the cluster is reachable.",
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
  );
}
