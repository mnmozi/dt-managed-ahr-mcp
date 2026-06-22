import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchTagGraph, fetchOwnershipTeams } from "../engine/tag-graph-fetcher.js";
import { analyzeTagSignals } from "../engine/analyzers/tags-signal-extraction.js";

/**
 * dt_extract_tag_signals — round 2a of the tag-strategy loop. For entities
 * that have no (or few) tags, extract CANDIDATE values from properties +
 * graph neighbors for the AI's chosen target keys. Engine computes
 * deterministic confidence scores; AI reads candidates and decides which
 * to apply.
 */
export function registerExtractTagSignals(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_extract_tag_signals",
    {
      description:
        "Round 2a of the tag-strategy workflow. For entities + target keys, the engine extracts candidate values from properties (env vars, awsTags, hostGroup, etc.) AND graph neighbors (containment parents, descendant/sibling/call-graph majority). Returns ranked candidates with deterministic confidence (boosted by existing-tag-value matches, ownership-directory matches, multi-source corroboration) + consensus picks where ≥2 sources agree at ≥0.70 confidence. The AI reads candidates and decides which to apply — engine never walks the graph for the AI. Use this AFTER dt_get_tag_snapshot when you have target keys.",
      inputSchema: {
        targetKeys: z
          .array(z.string())
          .min(1)
          .describe(
            "The tag keys to find candidate values for, e.g. ['team','env','project','application']. Required."
          ),
        entityIds: z
          .array(z.string())
          .optional()
          .describe(
            "Specific entity ids to extract for. If omitted, every entity in the graph is processed (heavy on big tenants)."
          ),
        existingTagValues: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe(
            "Per-key list of values already present elsewhere in the tenant. Boosts confidence on candidate values that match existing ones. Usually populated from a prior dt_get_tag_snapshot call."
          ),
        skipOwnershipTeamLookup: z
          .boolean()
          .optional()
          .describe(
            "If true, skip fetching builtin:ownership.teams. Default false — we fetch it because matching against the directory significantly boosts confidence for team-like keys."
          ),
        callGraphMajorityThreshold: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe(
            "Fraction of neighbors needed to call something a majority signal. Default 0.66."
          ),
        consensusMinConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum confidence for a value to be the consensus pick. Default 0.70."),
        consensusMinSources: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Minimum distinct sources agreeing for consensus. Default 2."),
      },
    },
    async (args) => {
      try {
        const [graphIn, teams] = await Promise.all([
          fetchTagGraph(client),
          args.skipOwnershipTeamLookup ? Promise.resolve([] as string[]) : fetchOwnershipTeams(client),
        ]);
        const engine = await getEngine();
        const result = await analyzeTagSignals(engine, {
          ...graphIn,
          targetKeys: args.targetKeys,
          entitiesToProcess: args.entityIds?.map((id) => ({ id })),
          existingTagValues: args.existingTagValues,
          ownershipTeams: teams,
          callGraphMajorityThreshold: args.callGraphMajorityThreshold,
          consensusMinConfidence: args.consensusMinConfidence,
          consensusMinSources: args.consensusMinSources,
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
                  reason: "tag signal extraction could not be computed",
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
