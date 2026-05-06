import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface OneAgent {
  hostInfo?: { hostName?: string; entityId?: string; osType?: string };
  faultyVersion?: boolean;
  active?: boolean;
  configurationMode?: string;
  monitoringType?: string;
  autoUpdateSetting?: string;
  updateStatus?: string;
  availabilityState?: string;
  modules?: Array<{ moduleType?: string; enabled?: boolean; version?: string }>;
  currentVersion?: string;
  installerVersion?: string;
  lastModuleUpdates?: unknown;
  [k: string]: unknown;
}

interface OneAgentListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  hosts?: OneAgent[];
}

function compareVersions(a: string, b: string): number {
  const parseV = (v: string) => v.split(/[.\-+]/).map((p) => Number.parseInt(p, 10) || 0);
  const av = parseV(a);
  const bv = parseV(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function registerOneAgentVersions(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_oneagent_versions",
    {
      description:
        "Audit OneAgent rollout health: per-host current version, OS, monitoring mode, autoUpdate setting, updateStatus, faultyVersion flag, last seen. Returns a per-host list AND a summary (count by version, by autoUpdate setting, by monitoring mode, faulty count, hosts > N versions behind latest).",
      inputSchema: {
        includeHosts: z
          .boolean()
          .optional()
          .describe(
            "If true, returns the full per-host list. Default false — only the summary, which is much smaller."
          ),
      },
    },
    async ({ includeHosts }) => {
      const all: OneAgent[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      const cap = 200;
      do {
        const resp = nextPageKey
          ? await client.get<OneAgentListResponse>("/api/v2/oneagents", {
              query: { nextPageKey },
            })
          : await client.get<OneAgentListResponse>("/api/v2/oneagents", {
              query: { pageSize: 500 },
            });
        if (resp.hosts) all.push(...resp.hosts);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < cap);

      // Summary
      const byVersion = new Map<string, number>();
      const byAutoUpdate = new Map<string, number>();
      const byMonitoring = new Map<string, number>();
      const byOs = new Map<string, number>();
      let faulty = 0;
      let inactive = 0;
      const versions: string[] = [];

      for (const h of all) {
        const v = h.currentVersion ?? h.installerVersion ?? "unknown";
        byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
        if (v !== "unknown") versions.push(v);
        const au = h.autoUpdateSetting ?? "UNKNOWN";
        byAutoUpdate.set(au, (byAutoUpdate.get(au) ?? 0) + 1);
        const mt = h.monitoringType ?? "UNKNOWN";
        byMonitoring.set(mt, (byMonitoring.get(mt) ?? 0) + 1);
        const os = h.hostInfo?.osType ?? "UNKNOWN";
        byOs.set(os, (byOs.get(os) ?? 0) + 1);
        if (h.faultyVersion) faulty++;
        if (h.active === false) inactive++;
      }

      const sortedVersions = [...new Set(versions)].sort(compareVersions);
      const latest = sortedVersions[sortedVersions.length - 1];
      const minorBehind = (v: string): number => {
        if (!latest) return 0;
        const lv = latest.split(".").map((p) => Number.parseInt(p, 10) || 0);
        const vv = v.split(".").map((p) => Number.parseInt(p, 10) || 0);
        return ((lv[0] ?? 0) - (vv[0] ?? 0)) * 1000 + ((lv[1] ?? 0) - (vv[1] ?? 0));
      };
      const outdatedHosts = all
        .filter((h) => {
          const v = h.currentVersion ?? h.installerVersion;
          return v && latest && minorBehind(v) >= 5; // 5+ minor versions behind
        })
        .map((h) => ({
          hostName: h.hostInfo?.hostName,
          entityId: h.hostInfo?.entityId,
          version: h.currentVersion ?? h.installerVersion,
          autoUpdateSetting: h.autoUpdateSetting,
        }));

      const summary = {
        totalHosts: all.length,
        latestVersionSeen: latest,
        versions: Object.fromEntries(byVersion),
        autoUpdateSettings: Object.fromEntries(byAutoUpdate),
        monitoringTypes: Object.fromEntries(byMonitoring),
        osTypes: Object.fromEntries(byOs),
        faultyVersionCount: faulty,
        inactiveCount: inactive,
        outdatedHostsCount: outdatedHosts.length,
        outdatedHostsSample: outdatedHosts.slice(0, 20),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(includeHosts ? { summary, hosts: all } : { summary }, null, 2),
          },
        ],
      };
    }
  );
}
