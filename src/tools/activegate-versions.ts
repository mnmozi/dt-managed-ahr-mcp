import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface ActiveGate {
  id?: string;
  networkAddresses?: string[];
  loadBalancerAddresses?: string[];
  osType?: string;
  autoUpdateStatus?: string;
  autoUpdateSettings?: { effectiveSetting?: string };
  hostname?: string;
  version?: string;
  type?: string; // ENVIRONMENT | CLUSTER | ENVIRONMENT_MULTI
  modules?: Array<{ type?: string; enabled?: boolean; misconfigured?: boolean }>;
  connectionStatus?: string;
  lastConnectedTime?: string;
  enabledModules?: string[];
  [k: string]: unknown;
}

interface ActiveGateListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  activeGates?: ActiveGate[];
}

export function registerActiveGateVersions(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_activegate_versions",
    {
      description:
        "Audit ActiveGate health: per-AG version, type (environment/cluster/multi-env), OS, autoUpdate, connection status, enabled modules. Returns per-AG list AND summary (count by version/type/autoUpdate, count of misconfigured modules, count not currently connected).",
      inputSchema: {
        includeAgs: z
          .boolean()
          .optional()
          .describe("If true, returns the full per-AG list. Default false — summary only."),
      },
    },
    async ({ includeAgs }) => {
      const all: ActiveGate[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      const cap = 50;
      do {
        const resp = nextPageKey
          ? await client.get<ActiveGateListResponse>("/api/v2/activeGates", {
              query: { nextPageKey },
            })
          : await client.get<ActiveGateListResponse>("/api/v2/activeGates", {
              query: { pageSize: 500 },
            });
        if (resp.activeGates) all.push(...resp.activeGates);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < cap);

      const byVersion = new Map<string, number>();
      const byType = new Map<string, number>();
      const byAutoUpdate = new Map<string, number>();
      const byConnection = new Map<string, number>();
      let misconfigured = 0;
      let notConnected = 0;

      for (const ag of all) {
        const v = ag.version ?? "unknown";
        byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
        const t = ag.type ?? "UNKNOWN";
        byType.set(t, (byType.get(t) ?? 0) + 1);
        const au =
          ag.autoUpdateSettings?.effectiveSetting ?? ag.autoUpdateStatus ?? "UNKNOWN";
        byAutoUpdate.set(au, (byAutoUpdate.get(au) ?? 0) + 1);
        const cs = ag.connectionStatus ?? "UNKNOWN";
        byConnection.set(cs, (byConnection.get(cs) ?? 0) + 1);
        if (cs && cs !== "ONLINE") notConnected++;
        if (ag.modules?.some((m) => m.misconfigured)) misconfigured++;
      }

      const summary = {
        totalActiveGates: all.length,
        versions: Object.fromEntries(byVersion),
        types: Object.fromEntries(byType),
        autoUpdateSettings: Object.fromEntries(byAutoUpdate),
        connectionStatuses: Object.fromEntries(byConnection),
        notConnectedCount: notConnected,
        misconfiguredModuleCount: misconfigured,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(includeAgs ? { summary, activeGates: all } : { summary }, null, 2),
          },
        ],
      };
    }
  );
}
