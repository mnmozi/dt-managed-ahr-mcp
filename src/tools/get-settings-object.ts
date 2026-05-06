import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

export function registerGetSettingsObject(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_settings_object",
    {
      description:
        "Fetch a single Settings 2.0 object by its objectId. Returns the full object including value, schemaId, scope, created/modified timestamps.",
      inputSchema: {
        objectId: z
          .string()
          .min(1)
          .describe("The objectId returned by dt_list_settings_objects (URL-safe base64-ish string)."),
      },
    },
    async ({ objectId }) => {
      const encoded = encodeURIComponent(objectId);
      const data = await client.get<unknown>(`/api/v2/settings/objects/${encoded}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
