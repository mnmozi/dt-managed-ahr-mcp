import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchNamingGraph } from "../engine/naming-graph-fetcher.js";
import { analyzeHostNaming } from "../engine/analyzers/hosts-naming-audit.js";

/**
 * dt_audit_host_naming — second read tool of the naming-hygiene pipeline.
 * Builds on dt_audit_process_group_naming because host candidates pull
 * from process group evidence (dominant PG, fleet membership).
 *
 * Two streams of candidates per generic-named host:
 *   1. Own properties: AWS tags (Name / Application / aws:autoscaling:groupName),
 *      GCP labels, Azure tags, Kubernetes node labels / node name, FQDN /
 *      DNS names with meaningful leading segment.
 *   2. Process-group evidence: dominant non-system PG (single app PG → high
 *      confidence), top-N app PGs (2-3 → each medium), fleet membership
 *      (≥ 3 hosts running the same PG set → fleet-match boosts the shared
 *      name to high confidence), bastion hint (only system PGs), shared-
 *      infra hint (many unrelated app PGs).
 *
 * The two streams merge through BucketAndRank — when AWS Name and the
 * dominant PG agree on the same name, the duplicate is collapsed at the
 * higher confidence so the operator sees one strong recommendation, not
 * two near-identical ones.
 *
 * Output uses the same EntityNamingReport shape as the PG audit, so the
 * same dt_apply_*_clarifying_tag lattice applies.
 */
export function registerAuditHostNaming(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_audit_host_naming",
    {
      description:
        "Audit host display names. Flags hosts whose name is generic (cloud-provider default like ip-10-0-1-23 / gke-prod-pool-xxx, bare technology, localhost) and extracts ranked candidate names from BOTH the host's own properties (AWS/GCP/Azure tags, Kubernetes labels, FQDN) AND its process groups (dominant non-system PG, top-N app PG names, fleet-match across same-PG-set hosts, bastion/shared-infra hints). Per-entity output uses the same confidence buckets (high_confidence | ambiguous | no_signal) as dt_audit_process_group_naming. Run AFTER dt_audit_process_group_naming so PG-name candidates feed the host audit cleanly. Args: maxCandidates (default 5).",
      inputSchema: {
        maxCandidates: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Cap on candidates surfaced per entity. Default 5 — higher values dilute the signal and overwhelm the operator."
          ),
      },
    },
    async ({ maxCandidates }) => {
      try {
        const graphIn = await fetchNamingGraph(client);
        const engine = await getEngine();
        const audit = await analyzeHostNaming(engine, {
          ...graphIn,
          maxCandidates,
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
                  reason: "host naming audit could not be computed",
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
