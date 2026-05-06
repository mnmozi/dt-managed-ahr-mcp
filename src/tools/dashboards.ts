import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface DashboardItem {
  id?: string;
  name?: string;
  owner?: string;
  shared?: boolean;
  [k: string]: unknown;
}

export function registerDashboards(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_dashboards_inventory",
    {
      description:
        "List dashboards via /api/config/v1/dashboards. Returns inventory + summary (count, count shared, count by owner, count of orphaned dashboards owned by users that may no longer exist). Note: 'apps' dashboards live in a separate app surface and are not visible here.",
      inputSchema: {},
    },
    async () => {
      try {
        const resp = await client.get<{ dashboards?: DashboardItem[] }>(
          "/api/config/v1/dashboards"
        );
        const dashboards = resp.dashboards ?? [];
        const byOwner = new Map<string, number>();
        let shared = 0;
        for (const d of dashboards) {
          byOwner.set(d.owner ?? "?", (byOwner.get(d.owner ?? "?") ?? 0) + 1);
          if (d.shared) shared++;
        }
        const summary = {
          totalDashboards: dashboards.length,
          sharedCount: shared,
          byOwner: Object.fromEntries(byOwner),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify({ summary, dashboards }, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof DtApiError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { available: false, error: { status: err.status, body: err.body.slice(0, 200) } },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );
}
