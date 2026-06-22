import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchTagGraph } from "../engine/tag-graph-fetcher.js";
import { analyzeTagStrategyCoverage } from "../engine/analyzers/tags-strategy-coverage.js";

/**
 * dt_simulate_tag_strategy — round 2b of the tag-strategy loop. Given a
 * proposed strategy (per key: ordered list of extraction sources), simulate
 * what coverage it would achieve. The AI uses this to decide whether the
 * strategy is workable end-to-end before any rule is written.
 */
export function registerSimulateTagStrategy(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_simulate_tag_strategy",
    {
      description:
        "Round 2b of the tag-strategy workflow. Given a proposed strategy { key: { extractFrom: [<source-spec>...], fallback? } }, simulate against the entity graph. Returns per-key per-type coverage % and the list of uncovered entities (with the sources that were tried for each missing key). Use this AFTER the AI has proposed a strategy from dt_extract_tag_signals output. Source spec grammar: 'property:<field>', 'awsTag:<Key>', 'envVar:<NAME>', 'containmentParent:tag:<key>', 'callGraphMajority:tag:<key>', 'siblingTag:<key>', 'hostName.token[N]', 'fallback:<literal>'.",
      inputSchema: {
        strategy: z
          .record(
            z.string(),
            z
              .object({
                extractFrom: z.array(z.string()).min(1),
                fallback: z.string().optional(),
              })
              .strict()
          )
          .describe(
            "The proposed strategy. Keys are tag keys; values describe how to extract a value for each."
          ),
        scopeEntityTypes: z
          .array(z.enum(["HOST", "PROCESS_GROUP", "PROCESS_GROUP_INSTANCE", "SERVICE"]))
          .optional()
          .describe(
            "Limit the simulation to specific entity types. Defaults to all four."
          ),
      },
    },
    async ({ strategy, scopeEntityTypes }) => {
      try {
        const graphIn = await fetchTagGraph(client);
        const engine = await getEngine();
        const result = await analyzeTagStrategyCoverage(engine, {
          ...graphIn,
          strategy,
          scopeEntityTypes,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
                  reason: "tag strategy simulation could not be computed",
                  error: msg,
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
