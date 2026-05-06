import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

/**
 * Older but still-live config API for conditional naming rules.
 * Settings 2.0 has equivalents (registered separately) but the v1 surface
 * is more uniformly available across Managed versions.
 */
export function registerConditionalNaming(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_conditional_naming",
    {
      description:
        "List conditional naming rules from /api/config/v1/conditionalNaming/{type}. These rules rename PGs / hosts / services in the UI based on conditions (tags, host group, env var, tech). Use this to understand why an entity has the display name it does, and to find generic-named entities that could be renamed.",
      inputSchema: {
        type: z
          .enum(["processGroup", "host", "service"])
          .describe("Which type of conditional naming rules to fetch."),
        includeDetails: z
          .boolean()
          .optional()
          .describe(
            "If true, fetches each rule's full body via /api/config/v1/conditionalNaming/<type>/<id>. Default false (list only)."
          ),
      },
    },
    async ({ type, includeDetails }) => {
      const list = await client.get<{
        values?: Array<{ id?: string; name?: string }>;
      }>(`/api/config/v1/conditionalNaming/${type}`);

      const values = list.values ?? [];
      if (!includeDetails) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { type, count: values.length, rules: values },
                null,
                2
              ),
            },
          ],
        };
      }

      const detailed: unknown[] = [];
      for (const rule of values) {
        if (!rule.id) continue;
        try {
          const detail = await client.get<unknown>(
            `/api/config/v1/conditionalNaming/${type}/${encodeURIComponent(rule.id)}`
          );
          detailed.push(detail);
        } catch (err) {
          detailed.push({
            id: rule.id,
            name: rule.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { type, count: detailed.length, rules: detailed },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
