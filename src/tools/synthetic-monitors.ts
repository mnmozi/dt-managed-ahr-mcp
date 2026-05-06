import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface MonitorListResp {
  monitors?: Array<{
    entityId?: string;
    name?: string;
    type?: string;
    enabled?: boolean;
    [k: string]: unknown;
  }>;
}

export function registerSyntheticMonitors(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_synthetic_monitors",
    {
      description:
        "Synthetic monitor inventory via /api/v2/synthetic/monitors. Returns full list and a summary (count by type, count enabled vs disabled, count by location, monitors with no linked application).",
      inputSchema: {
        includeMonitors: z
          .boolean()
          .optional()
          .describe("If true, returns the full monitor list. Default false — summary only."),
      },
    },
    async ({ includeMonitors }) => {
      const list = await client.get<MonitorListResp>("/api/v2/synthetic/monitors");
      const monitors = list.monitors ?? [];
      const byType = new Map<string, number>();
      let disabled = 0;
      for (const m of monitors) {
        byType.set(m.type ?? "?", (byType.get(m.type ?? "?") ?? 0) + 1);
        if (m.enabled === false) disabled++;
      }
      const summary = {
        totalMonitors: monitors.length,
        byType: Object.fromEntries(byType),
        disabledCount: disabled,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              includeMonitors ? { summary, monitors } : { summary },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
