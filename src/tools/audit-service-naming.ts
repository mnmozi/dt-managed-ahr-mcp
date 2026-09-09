import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchNamingGraph } from "../engine/naming-graph-fetcher.js";
import { analyzeServiceNaming } from "../engine/analyzers/services-naming-audit.js";

/**
 * dt_audit_service_naming — the fourth naming-hygiene audit, completing
 * the set (PGs, hosts, host groups, services).
 *
 * Flags services whose display name is generic (":80", "_:80", "gunicorn
 * on port 7100", bare protocols, Dynatrace synthetic names) and extracts
 * ranked candidates from:
 *   - the service's OWN endpoints (URL-path analysis — a service serving
 *     /bookings/* is probably the bookings service)
 *   - backing PGI k8s container / image / jar
 *   - backing PG display name (when the PG itself is well-named)
 *   - web context root
 *   - sole inbound caller (0.30 tiebreaker)
 *
 * Same buckets + lattice as the other audits; apply approved decisions
 * with dt_apply_service_clarifying_tag.
 */
export function registerAuditServiceNaming(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_audit_service_naming",
    {
      description:
        "Audit service display names. Flags services whose name is generic (port-only ':80'/'_:80', '<tech> on port N' defaults like 'gunicorn on port 7100', bare technology/protocol, Dynatrace synthetic names) and extracts ranked candidate names from the service's own endpoints (URL-path analysis), backing PGI k8s container/image/jar, backing PG display name, web context root, and sole inbound caller. Same confidence buckets (high_confidence | ambiguous | no_signal) as the PG/host audits. Run alongside dt_audit_process_group_naming — they share the same graph fetch. Args: maxCandidates (default 5).",
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
        explain: z
          .boolean()
          .optional()
          .describe(
            "If true, each report includes rejectedCandidates[] — every candidate the filter dropped, with the written reason (self-suggestion / generic / too long). Use when asking 'why did/didn't X get a suggestion?'."
          ),
        auditAll: z
          .boolean()
          .optional()
          .describe(
            "If true, emit a report for EVERY entity — healthy names get advisory candidates + corroborations (genericReason empty). Pattern tables always lag new technologies; this mode lets the operator judge each entity. Default false (only generic-named entities)."
          ),
      },
    },
    async ({ maxCandidates, explain, auditAll }) => {
      try {
        const graphIn = await fetchNamingGraph(client);
        const engine = await getEngine();
        const audit = await analyzeServiceNaming(engine, {
          ...graphIn,
          maxCandidates,
          explain,
          auditAll,
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
                  reason: "service naming audit could not be computed",
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
