import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface OAuthClient {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  creationDate?: string;
  expirationDate?: string | null;
  lastUsedDate?: string | null;
  scopes?: string[];
  [k: string]: unknown;
}

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export function registerOauthClients(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_oauth_clients",
    {
      description:
        "Inventory OAuth clients via /api/v2/oauthClients (newer Managed feature). Returns full list and a summary (count, never-used, stale, scope distribution). If the endpoint isn't on this DT version, returns 'available: false' instead of failing.",
      inputSchema: {
        includeClients: z.boolean().optional().describe("If true, returns the full client list. Default false."),
      },
    },
    async ({ includeClients }) => {
      try {
        const resp = await client.get<{ oauthClients?: OAuthClient[] }>(
          "/api/v2/oauthClients"
        );
        const clients = resp.oauthClients ?? [];
        const scopeCounts = new Map<string, number>();
        let neverUsed = 0;
        let stale90 = 0;
        let disabled = 0;
        for (const c of clients) {
          for (const s of c.scopes ?? []) scopeCounts.set(s, (scopeCounts.get(s) ?? 0) + 1);
          if (!c.lastUsedDate) neverUsed++;
          else if ((daysAgo(c.lastUsedDate) ?? 0) > 90) stale90++;
          if (c.enabled === false) disabled++;
        }
        const summary = {
          available: true,
          totalClients: clients.length,
          neverUsedCount: neverUsed,
          staleOver90dCount: stale90,
          disabledCount: disabled,
          scopeDistribution: Object.fromEntries(scopeCounts),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(includeClients ? { summary, clients } : { summary }, null, 2),
            },
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
          };
        }
        throw err;
      }
    }
  );
}
