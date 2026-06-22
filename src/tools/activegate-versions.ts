import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import {
  analyzeActiveGateDistribution,
  type ActiveGateRaw,
} from "../engine/analyzers/activegate-distribution.js";

/**
 * dt_get_activegate_versions — audit ActiveGate fleet health + capability map.
 *
 * Piping: fetches /api/v2/activeGates (paginated) AND the cluster's per-OS
 * latest version for ActiveGate installers. Engine does the analysis.
 */

interface ActiveGateListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  activeGates?: ActiveGateRaw[];
}

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
      const resp = await client.get<{ latestGatewayVersion?: string; latestAgentVersion?: string }>(
        `/api/v1/deployment/installer/gateway/${encodeURIComponent(osLower)}/default/latest/metainfo`
      );
      const v = resp?.latestGatewayVersion ?? resp?.latestAgentVersion;
      if (v) {
        map[osType] = v;
        continue;
      }
    } catch {
      // fall through
    }
    try {
      const resp = await client.get<{ availableVersions?: string[] }>(
        `/api/v1/deployment/installer/gateway/versions/${encodeURIComponent(osLower)}`
      );
      const versions = resp?.availableVersions ?? [];
      if (versions.length > 0) {
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

export function registerActiveGateVersions(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_activegate_versions",
    {
      description:
        "Audit ActiveGate fleet health and capability map. Returns version / type / autoUpdate / connection counts, per-OS 'behind latest' comparison, capability map (which AGs serve KUBERNETES / EXTENSION_CONTROLLER / BEACON_FORWARDER / etc.), network zone distribution, misconfigured-module detection. Use this to answer: 'which AGs collect k8s telemetry?', 'which network zone has no extension collector?', 'which AGs are outdated AND in prod?', 'are there single-points-of-failure in any capability?', 'show me misconfigured beacon forwarders'. Args: includeAgs (full inventory), skipLatestLookup, osTypeOverrides.",
      inputSchema: {
        includeAgs: z
          .boolean()
          .optional()
          .describe("If true, includes the full raw AG inventory alongside the summary. Default false."),
        skipLatestLookup: z
          .boolean()
          .optional()
          .describe(
            "If true, skip the per-OS latest-version lookup. AGs land in `activeGatesWithoutOsLatestReference`. Useful if the deployment installer endpoint is unavailable or token lacks scope."
          ),
        osTypeOverrides: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Pin a latest version per OS, applied AFTER cluster lookup. E.g. {'LINUX': '1.295.0'}."
          ),
      },
    },
    async ({ includeAgs, skipLatestLookup, osTypeOverrides }) => {
      // 1. Paginate /api/v2/activeGates
      const ags: ActiveGateRaw[] = [];
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
        if (resp.activeGates) ags.push(...resp.activeGates);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < cap);

      // 2. Per-OS latest
      const observedOs = new Set<string>();
      for (const ag of ags) {
        if (ag.osType) observedOs.add(ag.osType);
      }
      let latestVersionsByOs: Record<string, string> = {};
      let latestLookupErrors: Array<{ osType: string; error: string }> = [];
      if (!skipLatestLookup) {
        const { map, errors } = await fetchLatestVersionsByOs(client, observedOs);
        latestVersionsByOs = map;
        latestLookupErrors = errors;
      }
      if (osTypeOverrides) {
        for (const [k, v] of Object.entries(osTypeOverrides)) {
          latestVersionsByOs[k] = v;
        }
      }

      // 3. Engine
      let summary;
      try {
        const engine = await getEngine();
        summary = await analyzeActiveGateDistribution(engine, {
          activeGates: ags,
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
                  hint: "Set DT_ENGINE_BIN to the path of dt-engine.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // 4. Response
      const body: Record<string, unknown> = { summary };
      if (latestLookupErrors.length > 0) body.latestLookupErrors = latestLookupErrors;
      if (includeAgs) body.activeGates = ags;

      return {
        content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      };
    }
  );
}
