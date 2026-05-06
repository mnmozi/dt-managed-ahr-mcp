import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface TagsResponse {
  totalCount?: number;
  matchedEntitiesCount?: number;
  tags?: Array<{ context?: string; key?: string; value?: string; stringRepresentation?: string }>;
}

export function registerListTagsForEntity(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_list_tags_for_entity",
    {
      description:
        "List all tags applied to entities matching an EntitySelector. Returns each tag with its context (CONTEXTLESS, AWS, KUBERNETES, ENVIRONMENT, etc.) so you can distinguish manual tags from auto-tags and infrastructure-sourced tags.",
      inputSchema: {
        entitySelector: z
          .string()
          .min(1)
          .describe(
            "Dynatrace EntitySelector, e.g. 'type(HOST)', 'entityId(HOST-1234…)', 'type(PROCESS_GROUP),tag(app:foo)'."
          ),
        from: z
          .string()
          .optional()
          .describe("Optional 'from' timeframe, e.g. 'now-2h' or ISO timestamp. Defaults to server default."),
        to: z.string().optional().describe("Optional 'to' timeframe."),
      },
    },
    async ({ entitySelector, from, to }) => {
      const data = await client.get<TagsResponse>("/api/v2/tags", {
        query: { entitySelector, from, to },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
