import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { fetchOneAgents } from "../helpers/oneagents.js";
import {
  analyzeOneAgentDistribution,
  type OneAgentHostRaw,
} from "../engine/analyzers/oneagent-distribution.js";

/**
 * dt_get_oneagent_versions — audit OneAgent rollout health.
 *
 * This tool is "piping": it
 *   1. fetches the OneAgent inventory (v2 paginated, or v1 on Managed
 *      versions that don't serve v2 — normalized to the v2 shape)
 *   2. fetches the cluster's latest available version per OS
 *      (/api/v1/deployment/installer/agent/{os}/default/latest/metainfo)
 *   3. hands both to the engine's `oneagent.distribution` analyzer
 *   4. returns the analyzed summary (and optionally the raw host list)
 *
 * All actual math (counts, comparisons, "behind latest") lives in the engine.
 */

/**
 * Fetches the cluster's latest available OneAgent version for each OS that
 * actually appears in the host inventory. Returns a map osType → version.
 *
 * Tolerant: per-OS failures don't fail the whole call. If the endpoint
 * doesn't exist on this Managed version, returns an empty map and the
 * analyzer falls back to "no per-OS reference" mode for affected hosts.
 *
 * Endpoint candidates (varies by Managed version):
 *   1. GET /api/v1/deployment/installer/agent/{os}/default/latest/metainfo
 *      → returns { latestAgentVersion: "1.295.0" }
 *   2. GET /api/v1/deployment/installer/agent/versions/{os}
 *      → returns { availableVersions: ["1.290.0","1.291.0",...] }
 *
 * We try (1) first, fall back to (2) per OS.
 */
async function fetchLatestVersionsByOs(
  client: DtClient,
  osTypes: Set<string>
): Promise<{ map: Record<string, string>; errors: Array<{ osType: string; error: string }> }> {
  const map: Record<string, string> = {};
  const errors: Array<{ osType: string; error: string }> = [];

  for (const osType of osTypes) {
    if (osType === "UNKNOWN" || osType === "") continue;
    const osLower = osType.toLowerCase();
    try {
      const resp = await client.get<{ latestAgentVersion?: string }>(
        `/api/v1/deployment/installer/agent/${encodeURIComponent(osLower)}/default/latest/metainfo`
      );
      if (resp?.latestAgentVersion) {
        map[osType] = resp.latestAgentVersion;
        continue;
      }
    } catch {
      // fall through to v2
    }
    try {
      const resp = await client.get<{ availableVersions?: string[] }>(
        `/api/v1/deployment/installer/agent/versions/${encodeURIComponent(osLower)}`
      );
      const versions = resp?.availableVersions ?? [];
      if (versions.length > 0) {
        // last entry is typically newest; if not, the engine's comparison
        // logic doesn't depend on a perfectly-correct latest — it just
        // computes minorBehind against whatever we say is latest.
        const last = versions[versions.length - 1];
        if (typeof last === "string") {
          map[osType] = last;
          continue;
        }
      }
    } catch (err) {
      const msg =
        err instanceof DtApiError
          ? `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      errors.push({ osType, error: msg });
    }
  }
  return { map, errors };
}

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
            "If true, skip fetching the cluster's latest-version-per-OS. The 'behind latest' fields will be absent. Useful when the deployment installer endpoint is unavailable or the token lacks scope."
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
      // ---------- 1. OneAgent inventory (v2, or v1 fallback) ----------
      const inventory = await fetchOneAgents(client);
      const hosts = inventory.hosts as OneAgentHostRaw[];

      // ---------- 2. Fetch per-OS latest versions ----------
      const observedOsTypes = new Set<string>();
      for (const h of hosts) {
        const os = h.hostInfo?.osType;
        if (os) observedOsTypes.add(os);
      }
      let latestVersionsByOs: Record<string, string> = {};
      let latestLookupErrors: Array<{ osType: string; error: string }> = [];
      if (!skipLatestLookup) {
        const { map, errors } = await fetchLatestVersionsByOs(client, observedOsTypes);
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
      const responseBody: Record<string, unknown> = { summary, inventorySource: inventory.source };
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
