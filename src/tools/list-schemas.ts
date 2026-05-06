import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface SchemaListItem {
  schemaId?: string;
  displayName?: string;
  ownerBasedAccessControl?: boolean;
  multiObject?: boolean;
  latestSchemaVersion?: string;
  [k: string]: unknown;
}

interface SchemaListResponse {
  totalCount?: number;
  items?: SchemaListItem[];
}

export function registerListSchemas(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_list_schemas",
    {
      description:
        "List all Settings 2.0 schemas available on the environment. Returns schemaId, displayName, latestSchemaVersion, multiObject flag. Use this to discover which schemas exist before calling dt_list_settings_objects.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive substring to filter schemaId or displayName (client-side)."
          ),
      },
    },
    async ({ filter }) => {
      const data = await client.get<SchemaListResponse>("/api/v2/settings/schemas");
      let items = data.items ?? [];
      if (filter) {
        const needle = filter.toLowerCase();
        items = items.filter(
          (it) =>
            (it.schemaId ?? "").toLowerCase().includes(needle) ||
            (it.displayName ?? "").toLowerCase().includes(needle)
        );
      }
      const trimmed = items.map((it) => ({
        schemaId: it.schemaId,
        displayName: it.displayName,
        latestSchemaVersion: it.latestSchemaVersion,
        multiObject: it.multiObject,
        ownerBasedAccessControl: it.ownerBasedAccessControl,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { totalCount: data.totalCount ?? items.length, returned: trimmed.length, items: trimmed },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
