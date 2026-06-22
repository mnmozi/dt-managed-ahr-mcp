import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchNamingGraph } from "../engine/naming-graph-fetcher.js";
import { analyzeProcessGroupNaming } from "../engine/analyzers/processgroups-naming-audit.js";

/**
 * dt_audit_process_group_naming — first read-tool of the naming-hygiene
 * pipeline. Identifies process groups whose display name is generic
 * (port-only, bare technology, Dynatrace default) and returns ranked
 * candidate names extracted deterministically from each PG's properties
 * (JarFile, KubernetesContainerName, Executable, CLI args, JavaMainClass,
 * Docker image tail, softwareTechnologies).
 *
 * Output is bucketed by confidence:
 *   - high_confidence: engine picks one name (gap >= 0.20 from runner-up,
 *     top >= 0.80). Operator just approves.
 *   - ambiguous: multiple candidates close together. AI may propose with
 *     rationale from the engine's candidate list; operator confirms.
 *   - no_signal: no candidate above 0.40. Engine refuses to suggest.
 *     Operator must investigate manually.
 *
 * The companion write tool dt_apply_pg_naming_rule enforces these buckets
 * in code (lattice validation) — the AI cannot upgrade a no_signal entity
 * or invent a name not in the engine's candidate list.
 */
export function registerAuditPgNaming(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_audit_process_group_naming",
    {
      description:
        "Audit process group display names. Flags PGs whose name is generic (port-only, bare technology like 'java'/'python3', Dynatrace default patterns) and returns ranked candidate names extracted from each PG's properties (JarFile, KubernetesContainerName, CommandLineArguments --name=/--service=, JavaMainClass, Docker image tail, etc.). Per-entity output includes a confidence bucket (high_confidence | ambiguous | no_signal) so the operator can apply naming rules selectively. Use this as the FIRST step before tagging — name-based tag rules are unreliable if PGs are generically named. Args: maxCandidates (default 5).",
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
        const audit = await analyzeProcessGroupNaming(engine, {
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
                  reason: "process group naming audit could not be computed",
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
