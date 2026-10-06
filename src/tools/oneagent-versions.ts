import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import {
  analyzeOneAgentDistribution,
  type OneAgentHostRaw,
} from "../engine/analyzers/oneagent-distribution.js";
import { fetchLatestInstallerVersions } from "../helpers/installer-versions.js";

/**
 * dt_get_oneagent_versions — audit OneAgent rollout health.
 *
 * This tool is "piping": it
 *   1. fetches /api/v2/oneagents (auto-paginated)
 *   2. fetches the cluster's latest available version per OS
 *      (/api/v1/deployment/installer/agent/{os}/default/latest/metainfo)
 *   3. hands both to the engine's `oneagent.distribution` analyzer
 *   4. returns the analyzed summary (and optionally the raw host list)
 *
 * All actual math (counts, comparisons, "behind latest") lives in the engine.
 */

interface OneAgentListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  hosts?: OneAgentHostRaw[];
}

/*
 * The per-OS "latest available" lookup lives in helpers/installer-versions.ts
 * (shared with the ActiveGate tool). It maps the inventory osType (LINUX →
 * unix, …) to the Deployment API path segment, tries
 * /api/v1/deployment/installer/agent/{osType}/default/latest/metainfo and
 * falls back to /api/v1/deployment/installer/agent/versions/{osType}/default.
 * Needs the InstallerDownload scope; per-OS failures are reported, not fatal.
 */

export function registerOneAgentVersions(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_oneagent_versions",
    {
      description:
        "Audit OneAgent rollout health: per-host version, OS, monitoring mode, autoUpdate, faulty flag, plus per-OS 'behind latest' comparison against the cluster's available latest. Use this to answer: 'how many hosts are running an old version?', 'which hosts are full-stack vs infra and on which OS?', 'are there faulty OneAgent versions deployed anywhere?', 'show me hosts with auto-update disabled', 'which Linux hosts are >5 minor versions behind latest?'. Args: includeHosts (full inventory), skipLatestLookup, osTypeOverrides.",
      inputSchema: {
        includeHosts: z
          .boolean()
          .optional()
          .describe(
            "If true, returns the full per-host list alongside the summary. Default false (summary only — much smaller)."
          ),
        skipLatestLookup: z
          .boolean()
          .optional()
          .describe(
            "If true, skip fetching the cluster's latest-version-per-OS (Deployment API, needs the InstallerDownload scope). The 'behind latest' fields will be absent."
          ),
        osTypeOverrides: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional. Pin a latest version per OS for testing or to override what the cluster reports, e.g. {'LINUX': '1.295.0'}."
          ),
      },
    },
    async ({ includeHosts, skipLatestLookup, osTypeOverrides }) => {
      // ---------- 1. Paginate /api/v2/oneagents ----------
      const hosts: OneAgentHostRaw[] = [];
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
        if (resp.hosts) hosts.push(...resp.hosts);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < cap);

      // ---------- 2. Fetch per-OS latest versions ----------
      const observedOsTypes = new Set<string>();
      for (const h of hosts) {
        const os = h.hostInfo?.osType;
        if (os) observedOsTypes.add(os);
      }
      let latestVersionsByOs: Record<string, string> = {};
      let latestLookupErrors: Array<{ osType: string; error: string }> = [];
      if (!skipLatestLookup) {
        const { map, errors } = await fetchLatestInstallerVersions(client, observedOsTypes, "agent");
        latestVersionsByOs = map;
        latestLookupErrors = errors;
      }
      // Apply explicit overrides last so they win.
      if (osTypeOverrides) {
        for (const [k, v] of Object.entries(osTypeOverrides)) {
          latestVersionsByOs[k] = v;
        }
      }

      // ---------- 3. Hand to engine analyzer ----------
      let summary;
      try {
        const engine = await getEngine();
        summary = await analyzeOneAgentDistribution(engine, {
          hosts,
          latestVersionsByOs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  available: false,
                  reason: "engine unavailable — compute could not run",
                  error: msg,
                  hint:
                    "Set DT_ENGINE_BIN to the path of dt-engine, or build via `scripts/install-engine.sh`.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // ---------- 4. Shape response ----------
      const responseBody: Record<string, unknown> = { summary };
      if (latestLookupErrors.length > 0) {
        responseBody.latestLookupErrors = latestLookupErrors;
      }
      if (includeHosts) responseBody.hosts = hosts;

      return {
        content: [{ type: "text", text: JSON.stringify(responseBody, null, 2) }],
      };
    }
  );
}
