import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { fetchOneAgents, type OneAgentHost as OAHost } from "../helpers/oneagents.js";

const KNOWN_LOG_MODULES = ["LOG_ANALYTICS", "LOGS", "LOG"];

function isLogModule(t: string | undefined): boolean {
  if (!t) return false;
  const u = t.toUpperCase();
  return KNOWN_LOG_MODULES.some((k) => u.includes(k));
}

// Platforms / container runtimes OneAgent reports as detected technologies
// but never deep-monitors through a code module of their own. Without this,
// every Kubernetes node shows up as a "tech gap" (live on 1.350: 4/4 hosts).
const PLATFORM_TECHS = new Set([
  "KUBERNETES",
  "OPENSHIFT",
  "DOCKER",
  "CONTAINERD",
  "CRIO",
  "CRI_O",
  "PODMAN",
  "GARDEN",
  "CLOUD_FOUNDRY",
]);

export function isPlatformTech(t: string): boolean {
  return PLATFORM_TECHS.has(t.toUpperCase().replace(/-/g, "_"));
}

export function registerOneAgentModuleStatus(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_oneagent_module_status",
    {
      description:
        "Per-host OneAgent module status: which modules (log monitoring, autoinjection, network, etc.) are enabled/disabled on each host, and which detected technologies are present but NOT being deep-monitored. Specifically flags: hosts in FULL_STACK mode with the log module disabled (silent log gap), hosts running technologies the OneAgent detected but isn't deep-monitoring, and hosts with misconfigured modules.",
      inputSchema: {
        includeHosts: z
          .boolean()
          .optional()
          .describe("If true, returns full per-host detail. Default false — summary only."),
      },
    },
    async ({ includeHosts }) => {
      const inventory = await fetchOneAgents(client, { fields: "+modules,+detectedTechnologies" });
      const all: OAHost[] = inventory.hosts;
      // Managed 1.346 serves only /api/v1/oneagents, which returns modules:[]
      // for EVERY host (1.350 fills them in; fetchOneAgents normalizes the
      // instances[] shape to enabled/version). That is "module data unavailable", not "every host has
      // its log module off" — evaluating coverage on it would flag all hosts.
      const moduleDataAvailable = all.some((h) => (h.modules ?? []).length > 0);

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

      // Critical finding 1: hosts in FULL_STACK with log module disabled
      const fullStackHostsWithoutLogs = (moduleDataAvailable ? fullStackHosts : [])
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

      // Critical finding 2: detected technologies on FULL_STACK hosts that have NO matching enabled module
      // We can only approximate "deep-monitored tech" from module names — DT exposes one module per tech family.
      const techGapHosts: Array<{
        hostName?: string;
        entityId?: string;
        detectedTech: string[];
        enabledModules: string[];
        missingTechModules: string[];
      }> = [];

      for (const h of moduleDataAvailable ? fullStackHosts : []) {
        const detected = (h.detectedTechnologies ?? [])
          .map((t) => (t.type ?? "").toUpperCase())
          .filter((t) => t && !isPlatformTech(t));
        if (detected.length === 0) continue;
        const enabledModules = (h.modules ?? [])
          .filter((m) => m.enabled)
          .map((m) => (m.moduleType ?? "").toUpperCase());
        const missing: string[] = [];
        for (const tech of new Set(detected)) {
          // Heuristic: if any enabled module name contains the tech token, consider it covered.
          const covered = enabledModules.some(
            (mod) => mod.includes(tech) || tech.includes(mod.replace(/_/g, ""))
          );
          if (!covered) missing.push(tech);
        }
        if (missing.length > 0) {
          techGapHosts.push({
            hostName: h.hostInfo?.hostName,
            entityId: h.hostInfo?.entityId,
            detectedTech: [...new Set(detected)],
            enabledModules,
            missingTechModules: missing,
          });
        }
      }

      // Hosts with any module marked misconfigured
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
        inventorySource: inventory.source,
        moduleDataAvailable,
        ...(moduleDataAvailable
          ? {}
          : {
              warning:
                "No host in the inventory reports module details (the OneAgents API on this Managed version omits them). fullStackHostsWithoutLogs and techGapHosts were NOT evaluated — an empty list here is 'unknown', not 'clean'. Use HOST entity properties (logFileStatus / logSourceState via dt_get_process_properties) or builtin:logmonitoring.* settings to assess log coverage.",
            }),
        monitoringTypes: Object.fromEntries(monitoringTypeCounts),
        modulesEnabled: Object.fromEntries(moduleEnabledCount),
        modulesDisabled: Object.fromEntries(moduleDisabledCount),
        modulesMisconfigured: Object.fromEntries(moduleMisconfiguredCount),
        fullStackHostsWithoutLogsCount: fullStackHostsWithoutLogs.length,
        fullStackHostsWithoutLogsSample: fullStackHostsWithoutLogs.slice(0, 30),
        techGapHostsCount: techGapHosts.length,
        techGapHostsSample: techGapHosts.slice(0, 30),
        misconfiguredHostsCount: misconfiguredHosts.length,
        misconfiguredHostsSample: misconfiguredHosts.slice(0, 30),
        notes: [
          "fullStackHostsWithoutLogs = OneAgent in FULL_STACK mode but log monitoring module is missing or disabled — silent log coverage gap.",
          "techGapHosts = OneAgent detected one or more technologies on the host but no enabled module appears to cover them. Heuristic match — verify per-host before concluding. Platforms/container runtimes (Kubernetes, OpenShift, Docker, containerd, CRI-O, …) are excluded: they have no code module of their own.",
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
