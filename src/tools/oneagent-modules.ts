import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("oneagent-modules");

interface OAModule {
  moduleType?: string;
  enabled?: boolean;
  version?: string;
  misconfigured?: boolean;
}

interface OAHost {
  hostInfo?: { hostName?: string; entityId?: string; osType?: string };
  monitoringType?: string; // FULL_STACK | INFRASTRUCTURE | DISCOVERY etc.
  active?: boolean;
  faultyVersion?: boolean;
  modules?: OAModule[];
  currentVersion?: string;
  installerVersion?: string;
  [k: string]: unknown;
}

interface OAListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  hosts?: OAHost[];
}

interface HostTechResp {
  nextPageKey?: string | null;
  entities?: Array<{
    entityId?: string;
    properties?: { softwareTechnologies?: Array<{ type?: string; edition?: string; version?: string }> };
  }>;
}

const KNOWN_LOG_MODULES = ["LOG_ANALYTICS", "LOGS", "LOG"];

function isLogModule(t: string | undefined): boolean {
  if (!t) return false;
  const u = t.toUpperCase();
  return KNOWN_LOG_MODULES.some((k) => u.includes(k));
}

/**
 * Technologies that OneAgent can deep-monitor with a dedicated code module,
 * keyed by the softwareTechnologies `type` the HOST entity reports, mapped to
 * the moduleType(s) that cover it. Anything not in this table (databases,
 * message brokers, Docker, the OS itself, …) has no code module by design and
 * must never be reported as a "gap".
 */
const TECH_TO_MODULE: Record<string, string[]> = {
  JAVA: ["JAVA"],
  DOTNET: ["DOT_NET"],
  DOTNET_CORE: ["DOT_NET"],
  NODE_JS: ["NODE_JS"],
  NODEJS: ["NODE_JS"],
  PHP: ["PHP"],
  GO: ["GO"],
  GOLANG: ["GO"],
  PYTHON: ["PYTHON"],
  RUBY: ["RUBY"],
  NGINX: ["NGINX"],
  APACHE_HTTPD: ["APACHE"],
  APACHE: ["APACHE"],
  IIS: ["IIS"],
  VARNISH: ["VARNISH"],
  IBM_INTEGRATION_BUS: ["IBM_INTEGRATION_BUS"],
};

/**
 * HOST entities carry `properties.softwareTechnologies` (what OneAgent saw
 * running on the host). The /api/v2/oneagents inventory does not expose
 * detected technologies, so we join the two on entityId. Tolerant: if the
 * entities call fails (scope, timeout) the tech-gap finding is skipped and
 * the reason is surfaced in the response.
 */
async function fetchHostTechnologies(
  client: DtClient
): Promise<{ byHost: Map<string, string[]>; error?: string }> {
  const byHost = new Map<string, string[]>();
  let nextPageKey: string | null | undefined;
  let pages = 0;
  try {
    do {
      const resp = nextPageKey
        ? await client.get<HostTechResp>("/api/v2/entities", { query: { nextPageKey } })
        : await client.get<HostTechResp>("/api/v2/entities", {
            query: {
              entitySelector: "type(HOST)",
              fields: "+properties.softwareTechnologies",
              from: "now-24h",
              to: "now",
              pageSize: 1000,
            },
          });
      for (const e of resp.entities ?? []) {
        if (!e.entityId) continue;
        const techs = (e.properties?.softwareTechnologies ?? [])
          .map((t) => (t.type ?? "").toUpperCase())
          .filter((t) => t.length > 0);
        byHost.set(e.entityId, [...new Set(techs)]);
      }
      nextPageKey = resp.nextPageKey ?? null;
      pages++;
    } while (nextPageKey && pages < 50);
    return { byHost };
  } catch (err) {
    const msg =
      err instanceof DtApiError
        ? `HTTP ${err.status}${err.status === 403 ? " (entities.read scope missing)" : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    log.warn("host technology fetch failed; techGap finding skipped", { error: msg });
    return { byHost, error: msg };
  }
}

export function registerOneAgentModuleStatus(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_oneagent_module_status",
    {
      description:
        "Per-host OneAgent module status (GET /api/v2/oneagents?includeDetails=true joined with HOST softwareTechnologies): which code modules (Java, .NET, Node.js, log analytics, network, …) are enabled/disabled per host, and which deep-monitorable technologies the host runs with NO enabled module. Flags: FULL_STACK hosts with the log module missing/disabled (silent log gap), hosts running Java/.NET/Node/PHP/Go/Python/Ruby/nginx/Apache/IIS without the matching module (tech gap), and hosts with misconfigured modules. Needs oneAgents.read + entities.read.",
      inputSchema: {
        includeHosts: z
          .boolean()
          .optional()
          .describe("If true, returns full per-host detail. Default false — summary only."),
        sampleSize: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("How many hosts to list per finding. Default 30."),
      },
    },
    async ({ includeHosts, sampleSize }) => {
      const sample = sampleSize ?? 30;
      const all: OAHost[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      const cap = 200;
      try {
        do {
          const resp = nextPageKey
            ? await client.get<OAListResp>("/api/v2/oneagents", {
                query: { nextPageKey },
              })
            : await client.get<OAListResp>("/api/v2/oneagents", {
                // includeDetails is what brings modules[] along (it defaults to
                // true, but we pin it so a future default flip can't blank the tool).
                query: { pageSize: 500, includeDetails: true },
              });
          if (resp.hosts) all.push(...resp.hosts);
          nextPageKey = resp.nextPageKey ?? null;
          pages++;
        } while (nextPageKey && pages < cap);
      } catch (err) {
        if (err instanceof DtApiError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    available: false,
                    error: { status: err.status, body: err.body.slice(0, 500) },
                    hint: err.status === 403 ? "token needs the oneAgents.read scope" : undefined,
                  },
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

      const techFetch = await fetchHostTechnologies(client);

      const moduleEnabledCount = new Map<string, number>();
      const moduleDisabledCount = new Map<string, number>();
      const moduleMisconfiguredCount = new Map<string, number>();
      const monitoringTypeCounts = new Map<string, number>();
      const fullStackHosts: OAHost[] = [];

      for (const h of all) {
        monitoringTypeCounts.set(
          h.monitoringType ?? "UNKNOWN",
          (monitoringTypeCounts.get(h.monitoringType ?? "UNKNOWN") ?? 0) + 1
        );
        if (h.monitoringType === "FULL_STACK") fullStackHosts.push(h);
        for (const m of h.modules ?? []) {
          const t = m.moduleType ?? "UNKNOWN";
          if (m.enabled) moduleEnabledCount.set(t, (moduleEnabledCount.get(t) ?? 0) + 1);
          else moduleDisabledCount.set(t, (moduleDisabledCount.get(t) ?? 0) + 1);
          if (m.misconfigured)
            moduleMisconfiguredCount.set(t, (moduleMisconfiguredCount.get(t) ?? 0) + 1);
        }
      }

      // Finding 1: hosts in FULL_STACK with log module missing or disabled
      const fullStackHostsWithoutLogs = fullStackHosts
        .filter((h) => {
          const logMods = (h.modules ?? []).filter((m) => isLogModule(m.moduleType));
          if (logMods.length === 0) return true; // no log module at all
          return logMods.every((m) => m.enabled === false);
        })
        .map((h) => ({
          hostName: h.hostInfo?.hostName,
          entityId: h.hostInfo?.entityId,
          osType: h.hostInfo?.osType,
          modules: (h.modules ?? []).map((m) => ({ type: m.moduleType, enabled: m.enabled })),
        }));

      // Finding 2: deep-monitorable technology present on a FULL_STACK host
      // but no enabled module covers it. Only technologies with a code module
      // (TECH_TO_MODULE) are considered — databases etc. are not gaps.
      const techGapHosts: Array<{
        hostName?: string;
        entityId?: string;
        detectedTech: string[];
        enabledModules: string[];
        missingTechModules: string[];
      }> = [];
      if (!techFetch.error) {
        for (const h of fullStackHosts) {
          const id = h.hostInfo?.entityId;
          const detected = id ? techFetch.byHost.get(id) ?? [] : [];
          if (detected.length === 0) continue;
          const enabledModules = (h.modules ?? [])
            .filter((m) => m.enabled)
            .map((m) => (m.moduleType ?? "").toUpperCase());
          const missing: string[] = [];
          for (const tech of detected) {
            const needed = TECH_TO_MODULE[tech];
            if (!needed) continue; // no code module exists for this technology
            if (!needed.some((mod) => enabledModules.includes(mod))) missing.push(tech);
          }
          if (missing.length > 0) {
            techGapHosts.push({
              hostName: h.hostInfo?.hostName,
              entityId: id,
              detectedTech: detected,
              enabledModules,
              missingTechModules: missing,
            });
          }
        }
      }

      // Finding 3: any module flagged misconfigured by OneAgent itself
      const misconfiguredHosts = all
        .filter((h) => (h.modules ?? []).some((m) => m.misconfigured))
        .map((h) => ({
          hostName: h.hostInfo?.hostName,
          entityId: h.hostInfo?.entityId,
          modules: (h.modules ?? [])
            .filter((m) => m.misconfigured)
            .map((m) => m.moduleType),
        }));

      const summary = {
        totalHosts: all.length,
        monitoringTypes: Object.fromEntries(monitoringTypeCounts),
        modulesEnabled: Object.fromEntries(moduleEnabledCount),
        modulesDisabled: Object.fromEntries(moduleDisabledCount),
        modulesMisconfigured: Object.fromEntries(moduleMisconfiguredCount),
        fullStackHostsWithoutLogsCount: fullStackHostsWithoutLogs.length,
        fullStackHostsWithoutLogsSample: fullStackHostsWithoutLogs.slice(0, sample),
        techGapAvailable: !techFetch.error,
        techGapUnavailableReason: techFetch.error,
        techGapHostsCount: techGapHosts.length,
        techGapHostsSample: techGapHosts.slice(0, sample),
        misconfiguredHostsCount: misconfiguredHosts.length,
        misconfiguredHostsSample: misconfiguredHosts.slice(0, sample),
        notes: [
          "fullStackHostsWithoutLogs = OneAgent in FULL_STACK mode but the log monitoring module is missing or disabled — silent log coverage gap.",
          "techGapHosts = HOST.properties.softwareTechnologies lists a technology that has a OneAgent code module (Java/.NET/Node/PHP/Go/Python/Ruby/nginx/Apache/IIS/Varnish/IIB) but no enabled module of that type on the host. Technologies without a code module (databases, brokers, Docker, …) are never counted.",
          "Module names follow /api/v2/oneagents moduleType values (JAVA, DOT_NET, NODE_JS, LOG_ANALYTICS, NETWORK, …).",
        ],
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
