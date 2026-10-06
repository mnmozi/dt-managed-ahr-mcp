import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  scope?: string;
  modified?: number;
  [k: string]: unknown;
}

interface SettingsListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

const SCHEMAS_TO_SCAN = [
  "builtin:tags.auto-tagging",
  "builtin:management-zones",
  "builtin:process-group.advanced-detection-rule",
  "builtin:process-group.detection-flags",
  "builtin:service-detection.full-web-service",
  "builtin:service-detection.full-web-request",
  "builtin:service-detection.external-web-service",
  "builtin:service-detection.external-web-request",
  "builtin:service.request-naming",
  "builtin:service.request-attributes",
  "builtin:alerting.profile",
  "builtin:alerting.maintenance-window",
  "builtin:problem.notifications",
  "builtin:anomaly-detection.metric-events",
  "builtin:anomaly-detection.services",
  "builtin:anomaly-detection.infrastructure-hosts",
  "builtin:host.process-monitoring",
  "builtin:logmonitoring.processing-rule",
  "builtin:span-capturing",
];

const ENTITY_PREFIXES = [
  "HOST",
  "HOST_GROUP",
  "PROCESS_GROUP",
  "PROCESS_GROUP_INSTANCE",
  "SERVICE",
  "APPLICATION",
  "MOBILE_APPLICATION",
  "CUSTOM_APPLICATION",
  "CUSTOM_DEVICE",
  "CUSTOM_DEVICE_GROUP",
  "KUBERNETES_CLUSTER",
  "CLOUD_APPLICATION",
  "CLOUD_APPLICATION_NAMESPACE",
  "AWS_CREDENTIALS",
  "AZURE_CREDENTIALS",
];

function isEntityScope(scope: string): boolean {
  return ENTITY_PREFIXES.some((p) => scope.startsWith(p + "-"));
}

export function registerOrphanScopes(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_orphan_settings_scopes",
    {
      description:
        "Find Settings 2.0 objects scoped to entity ids that no longer exist (decommissioned hosts, churned k8s entities, deleted apps). Scans a curated set of high-signal schemas. For each suspected orphan, looks the entity up via /api/v2/entities/{id} over a 30d window (configurable) and reports objects whose scope returns 404. Lookups that fail for any other reason (403, 429, timeout) are reported as 'unverified', never as orphans.",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe("Lookback for the entity existence check. Default 'now-30d' — an entity unseen for a month is a much safer 'gone' signal than the API's 3-day default."),
        maxLookups: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Cap on entity-existence lookups to avoid blowing up on huge tenants. Default 500."),
      },
    },
    async ({ from, maxLookups }) => {
      const cap = maxLookups ?? 500;
      const lookback = from ?? "now-30d";
      const candidates: SettingsObject[] = [];

      // Pull settings objects across the curated schemas, collect entity-scoped ones.
      for (const schemaId of SCHEMAS_TO_SCAN) {
        try {
          let nextPageKey: string | null | undefined;
          let pages = 0;
          do {
            const resp = nextPageKey
              ? await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: { nextPageKey },
                })
              : await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: { schemaIds: schemaId, pageSize: 500, fields: "objectId,schemaId,scope,modified" },
                });
            for (const it of resp.items ?? []) {
              if (it.scope && isEntityScope(it.scope)) candidates.push(it);
            }
            nextPageKey = resp.nextPageKey ?? null;
            pages++;
          } while (nextPageKey && pages < 20);
        } catch {
          // ignore — schema may not exist on this version
        }
      }

      // Deduplicate by scope (one entity may be referenced by many objects).
      const uniqueScopes = [...new Set(candidates.map((c) => c.scope!))].slice(0, cap);
      const orphanScopes = new Set<string>();
      const liveScopes = new Set<string>();
      const unverified: Array<{ scope: string; error: string }> = [];

      for (const scope of uniqueScopes) {
        try {
          await client.get<unknown>(`/api/v2/entities/${encodeURIComponent(scope)}`, {
            query: { from: lookback, to: "now" },
          });
          liveScopes.add(scope);
        } catch (err) {
          if (err instanceof DtApiError && err.status === 404) {
            orphanScopes.add(scope);
          } else {
            unverified.push({
              scope,
              error: err instanceof DtApiError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const orphanObjects = candidates.filter((c) => orphanScopes.has(c.scope!));
      const summary = {
        scannedSchemas: SCHEMAS_TO_SCAN.length,
        entityLookback: lookback,
        entityScopedObjectsFound: candidates.length,
        uniqueScopesChecked: uniqueScopes.length,
        liveScopeCount: liveScopes.size,
        orphanScopeCount: orphanScopes.size,
        orphanObjectsCount: orphanObjects.length,
        unverifiedScopeCount: unverified.length,
        unverifiedSample: unverified.slice(0, 20),
        truncated: candidates.length > cap,
        orphanObjectsSample: orphanObjects.slice(0, 50).map((o) => ({
          objectId: o.objectId,
          schemaId: o.schemaId,
          scope: o.scope,
          modified: o.modified,
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
