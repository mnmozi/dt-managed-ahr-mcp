import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

export function registerRawGet(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_raw_get",
    {
      description:
        "Escape hatch: GET any path on the Dynatrace API that the other tools don't wrap. Path is appended to the environment base URL by default (https://<cluster>/e/<env>); set scope='cluster' for cluster-scoped paths. Use this only when a typed tool doesn't exist.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "API path starting with '/' — e.g. '/api/v2/entities' or '/api/config/v1/autoTags'. Do NOT include the /e/<env>/ prefix; it is added automatically for scope='env'."
          ),
        scope: z
          .enum(["env", "cluster"])
          .optional()
          .describe("Which base to prepend and which token to use. Default: 'env'."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional query parameters as a flat object."),
      },
    },
    async ({ path, scope, query }) => {
      const data = await client.get<unknown>(path, { scope: scope ?? "env", query });
      const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text: body }] };
    }
  );
}
