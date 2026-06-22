import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchTagGraph, fetchAutoTagRules } from "../engine/tag-graph-fetcher.js";
import { analyzeTagSnapshot } from "../engine/analyzers/tags-snapshot.js";

/**
 * dt_get_tag_snapshot — round 1 of the tag-strategy loop. Returns the
 * tenant's full tag state in one structured blob so the AI can judge
 * whether there's a coherent tagging strategy.
 *
 * Piping: fetches hosts + PGs + PGIs + services with tags + properties +
 * relationships, plus auto-tag rules. Hands to engine's tags.snapshot.
 *
 * The engine produces:
 *   - per-type entity counts (incl. how many have ≤N tags)
 *   - per-key taxonomy (coverage per type, distinct values, value-format
 *     judgment, sourcing rule ids)
 *   - key similarity clusters (typo / variant detection)
 *   - low-tag entities + their subgraph with parent/sibling/neighbor tag
 *     distributions pre-computed (the AI doesn't walk the tree)
 *   - propagation hints per key
 */
export function registerTagSnapshot(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_tag_snapshot",
    {
      description:
        "Round 1 of the tag-strategy workflow. Comprehensive snapshot of the tenant's tag state: per-type counts (incl. untagged entities), per-key taxonomy with coverage / value-format judgment, key similarity clusters (typo detection), low-tag entities + their subgraph with parent/sibling/neighbor tag distributions, per-key propagation hints. Use this to answer: 'is there a coherent tagging strategy?', 'which entities are untagged?', 'which keys look like typos of each other?', 'are tag values inconsistent in case/spelling?', 'which entity types lack ownership tags?'. Args: lowTagThreshold (default 1), graphMode (low_tag_only | full | none).",
      inputSchema: {
        lowTagThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Entities with this many or fewer tags are flagged as low-tag. Default 1 — an entity with only 1 infrastructure auto-tag isn't really 'tagged'."
          ),
        graphMode: z
          .enum(["low_tag_only", "full", "none"])
          .optional()
          .describe(
            "How much of the entity graph to include in output. 'low_tag_only' (default) emits just the subgraph around low-tag entities. 'full' emits every node (heavy on big tenants). 'none' skips the graph."
          ),
      },
    },
    async ({ lowTagThreshold, graphMode }) => {
      try {
        const [graphIn, rules] = await Promise.all([
          fetchTagGraph(client),
          fetchAutoTagRules(client),
        ]);
        const engine = await getEngine();
        const snapshot = await analyzeTagSnapshot(engine, {
          ...graphIn,
          autoTagRules: rules,
          lowTagThreshold,
          graphMode,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
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
                  reason: "tag snapshot could not be computed",
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
