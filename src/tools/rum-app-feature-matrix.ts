import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: Array<{
    objectId?: string;
    schemaId?: string;
    scope?: string;
    summary?: string;
    value?: Record<string, unknown> | null;
    modified?: number;
  }>;
}

/**
 * Catalog of RUM "features" we audit per application.
 * Each entry says which schema(s) to look at, which app type(s) it applies to,
 * and how to extract the "enabled / configured" signal from the value.
 */
interface FeatureDef {
  feature: string;
  description: string;
  appTypes: string[]; // APPLICATION, MOBILE_APPLICATION, CUSTOM_APPLICATION
  schemaIds: string[];
  // path within value to read for "enabled" — boolean field, count of entries, or "exists" check
  signal:
    | { kind: "boolean"; path: string[] }
    | { kind: "exists" } // configured = at least one object scoped here
    | { kind: "count"; path: string[] } // count of items in an array at this path
    | { kind: "value"; path: string[] };
  recommendation: string;
}

const FEATURES: FeatureDef[] = [
  {
    feature: "session_replay",
    description: "Session Replay enabled for the app",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.session-replay-web", "builtin:sessionreplay.web.privacy-preferences"],
    signal: { kind: "boolean", path: ["enabled"] },
    recommendation: "Enable Session Replay for high-traffic apps to debug user issues.",
  },
  {
    feature: "session_replay_mobile",
    description: "Session Replay (Mobile) configured for the app",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.session-replay-mobile"],
    signal: { kind: "exists" },
    recommendation: "Enable mobile Session Replay if licensed.",
  },
  {
    feature: "rum_enabled",
    description: "RUM enablement / cost control",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.enablement"],
    signal: { kind: "boolean", path: ["enabled"] },
    recommendation: "Configure capture rate explicitly per app — defaults often too high or too low.",
  },
  {
    feature: "rum_enabled_mobile",
    description: "RUM enablement (mobile) / cost control",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.mobile.enablement"],
    signal: { kind: "boolean", path: ["enabled"] },
    recommendation: "Configure mobile capture rate explicitly per app.",
  },
  {
    feature: "rum_enabled_custom",
    description: "RUM enablement (custom) / cost control",
    appTypes: ["CUSTOM_APPLICATION"],
    schemaIds: ["builtin:rum.custom.enablement"],
    signal: { kind: "boolean", path: ["enabled"] },
    recommendation: "Configure custom-app capture rate explicitly per app.",
  },
  {
    feature: "user_tagging",
    description: "User tagging configured (lets you identify users in sessions)",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.user-tagging"],
    signal: { kind: "exists" },
    recommendation: "Configure user tagging if you want to associate sessions with user identities (audit PII handling first).",
  },
  {
    feature: "custom_errors",
    description: "Custom error rules defined",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.custom-errors"],
    signal: { kind: "exists" },
    recommendation: "Define custom error rules for app-specific error patterns (e.g. 'API timeout' instead of generic JS error).",
  },
  {
    feature: "key_user_actions",
    description: "Key User Actions defined",
    appTypes: ["APPLICATION", "MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.key-user-actions"],
    signal: { kind: "exists" },
    recommendation: "Define at least one Key User Action per app to track conversion / SLO.",
  },
  {
    feature: "session_properties",
    description: "Session properties defined",
    appTypes: ["APPLICATION", "MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.session-properties"],
    signal: { kind: "exists" },
    recommendation: "Configure session properties to enrich sessions with business context (audit PII first).",
  },
  {
    feature: "conversion_goals",
    description: "Conversion goals defined",
    appTypes: ["APPLICATION", "MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.conversion-goals"],
    signal: { kind: "exists" },
    recommendation: "Define conversion goals to measure user journeys; required for funnel analysis.",
  },
  {
    feature: "user_action_naming",
    description: "User-action naming rules defined",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.user-action-naming.web", "builtin:rum.web.user-action-naming"],
    signal: { kind: "exists" },
    recommendation: "Add user-action naming rules to prevent per-id action-name cardinality blowup.",
  },
  {
    feature: "user_action_naming_mobile",
    description: "User-action naming rules (mobile) defined",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.user-action-naming.mobile"],
    signal: { kind: "exists" },
    recommendation: "Add mobile user-action naming rules to prevent action cardinality blowup.",
  },
  {
    feature: "apdex_load",
    description: "Apdex thresholds for load actions",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.key-performance-metric-load-actions"],
    signal: { kind: "exists" },
    recommendation: "Override default Apdex thresholds with values matching this app's actual p50/p95.",
  },
  {
    feature: "apdex_xhr",
    description: "Apdex thresholds for XHR actions",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.key-performance-metric-xhr-actions"],
    signal: { kind: "exists" },
    recommendation: "Override default XHR Apdex thresholds with values matching observed XHR latency.",
  },
  {
    feature: "apdex_custom",
    description: "Apdex thresholds for custom actions",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.key-performance-metric-custom-actions"],
    signal: { kind: "exists" },
    recommendation: "Set custom-action Apdex if the app emits custom actions.",
  },
  {
    feature: "apdex_mobile",
    description: "Apdex / KPM (mobile)",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.mobile.key-performance-metrics"],
    signal: { kind: "exists" },
    recommendation: "Override default mobile Apdex thresholds.",
  },
  {
    feature: "resource_cleanup",
    description: "Resource URL cleanup rules (cardinality control)",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.resource-cleanup-rules"],
    signal: { kind: "exists" },
    recommendation: "Add resource URL cleanup rules so per-id resource URLs don't blow up cardinality.",
  },
  {
    feature: "xhr_exclusion",
    description: "XHR exclusion rules",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.xhr-exclusion"],
    signal: { kind: "exists" },
    recommendation: "Configure XHR exclusion to drop noise (analytics calls, health checks).",
  },
  {
    feature: "ipaddress_exclusion",
    description: "IP address exclusion rules",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.ipaddress-exclusion"],
    signal: { kind: "exists" },
    recommendation: "Exclude internal/test IPs to keep production user metrics clean.",
  },
  {
    feature: "browser_exclusion",
    description: "Browser exclusion rules",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.browser-exclusion"],
    signal: { kind: "exists" },
    recommendation: "Configure if you want to exclude bot UAs or unsupported browsers.",
  },
  {
    feature: "custom_injection",
    description: "Custom injection rules",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.custom-injection-rules"],
    signal: { kind: "exists" },
    recommendation: "Add only if standard injection isn't sufficient (rare).",
  },
  {
    feature: "privacy_preferences",
    description: "Session-replay privacy preferences",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:sessionreplay.web.privacy-preferences"],
    signal: { kind: "exists" },
    recommendation: "Required if Session Replay is enabled. Audit masking rules carefully.",
  },
  {
    feature: "privacy_preferences_mobile",
    description: "Mobile privacy settings",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.mobile.privacy"],
    signal: { kind: "exists" },
    recommendation: "Configure mobile privacy/redaction for compliance.",
  },
  {
    feature: "anomaly_detection",
    description: "Per-app anomaly detection override",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:anomaly-detection.rum-web"],
    signal: { kind: "exists" },
    recommendation: "Override AD thresholds per app if global defaults are noisy or insensitive.",
  },
  {
    feature: "anomaly_detection_mobile",
    description: "Per-app anomaly detection (mobile)",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:anomaly-detection.rum-mobile", "builtin:anomaly-detection.rum-mobile-crash-rate-increase"],
    signal: { kind: "exists" },
    recommendation: "Override mobile AD per app if global defaults are off.",
  },
  {
    feature: "anomaly_detection_custom",
    description: "Per-app anomaly detection (custom)",
    appTypes: ["CUSTOM_APPLICATION"],
    schemaIds: ["builtin:anomaly-detection.rum-custom", "builtin:anomaly-detection.rum-custom-crash-rate-increase"],
    signal: { kind: "exists" },
    recommendation: "Override custom-app AD per app.",
  },
  {
    feature: "request_errors",
    description: "Request-error rules",
    appTypes: ["APPLICATION"],
    schemaIds: ["builtin:rum.web.request-errors"],
    signal: { kind: "exists" },
    recommendation: "Define request-error rules to mark certain HTTP outcomes as errors.",
  },
  {
    feature: "request_errors_mobile",
    description: "Request-error rules (mobile)",
    appTypes: ["MOBILE_APPLICATION"],
    schemaIds: ["builtin:rum.mobile.request-errors"],
    signal: { kind: "exists" },
    recommendation: "Define mobile request-error rules.",
  },
];

function readPath(obj: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

async function fetchSchemaObjects(
  client: DtClient,
  schemaId: string
): Promise<NonNullable<SettingsListResp["items"]>> {
  const all: NonNullable<SettingsListResp["items"]> = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    try {
      const resp = nextPageKey
        ? await client.get<SettingsListResp>("/api/v2/settings/objects", {
            query: { nextPageKey },
          })
        : await client.get<SettingsListResp>("/api/v2/settings/objects", {
            query: {
              schemaIds: schemaId,
              pageSize: 500,
              fields: "objectId,schemaId,scope,summary,value,modified",
            },
          });
      if (resp.items) all.push(...resp.items);
      nextPageKey = resp.nextPageKey ?? null;
      pages++;
    } catch (err) {
      if (err instanceof DtApiError) return all; // schema not present — skip
      throw err;
    }
  } while (nextPageKey && pages < 20);
  return all;
}

export function registerRumAppFeatureMatrix(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_rum_app_feature_matrix",
    {
      description:
        "For each RUM application, audit which features are configured/enabled/missing. Returns a per-app matrix across ~25 features (Session Replay, RUM enablement, user tagging, custom errors, KUAs, session properties, conversion goals, user-action naming, apdex thresholds, resource cleanup, exclusions, privacy, anomaly detection). For each feature: configured? enabled? scope (per-app override or env default)? + a recommendation if not configured.",
      inputSchema: {
        applicationId: z
          .string()
          .optional()
          .describe("Optional: audit a single APPLICATION/MOBILE_APPLICATION/CUSTOM_APPLICATION id. Default: all RUM apps."),
        from: z.string().optional().describe("Window for app discovery. Default 'now-24h'."),
        to: z.string().optional().describe("Default 'now'."),
      },
    },
    async ({ applicationId, from, to }) => {
      const window = { from: from ?? "now-24h", to: to ?? "now" };

      // 1. Discover apps (or use the single id)
      let apps: Array<{ id: string; name?: string; type: string }> = [];
      if (applicationId) {
        const t = applicationId.startsWith("MOBILE_APPLICATION-")
          ? "MOBILE_APPLICATION"
          : applicationId.startsWith("CUSTOM_APPLICATION-")
            ? "CUSTOM_APPLICATION"
            : "APPLICATION";
        apps = [{ id: applicationId, type: t }];
      } else {
        for (const t of ["APPLICATION", "MOBILE_APPLICATION", "CUSTOM_APPLICATION"]) {
          let nextPageKey: string | null | undefined;
          let pages = 0;
          do {
            const resp = nextPageKey
              ? await client.get<{ entities?: Array<{ entityId?: string; displayName?: string }>; nextPageKey?: string | null }>(
                  "/api/v2/entities",
                  { query: { nextPageKey } }
                )
              : await client.get<{ entities?: Array<{ entityId?: string; displayName?: string }>; nextPageKey?: string | null }>(
                  "/api/v2/entities",
                  {
                    query: {
                      entitySelector: `type(${t})`,
                      from: window.from,
                      to: window.to,
                      pageSize: 500,
                    },
                  }
                );
            for (const e of resp.entities ?? []) {
              if (e.entityId) apps.push({ id: e.entityId, name: e.displayName, type: t });
            }
            nextPageKey = resp.nextPageKey ?? null;
            pages++;
          } while (nextPageKey && pages < 20);
        }
      }

      // 2. Pull all relevant schemas once and group by scope
      const schemaSet = new Set<string>();
      for (const f of FEATURES) for (const s of f.schemaIds) schemaSet.add(s);
      const objectsBySchema = new Map<string, NonNullable<SettingsListResp["items"]>>();
      for (const sid of schemaSet) {
        objectsBySchema.set(sid, await fetchSchemaObjects(client, sid));
      }

      // 3. Per-app feature matrix
      const result: unknown[] = [];
      for (const app of apps) {
        const features: Array<{
          feature: string;
          description: string;
          status: "configured-explicit" | "configured-via-default" | "missing" | "n/a";
          enabled?: boolean | null;
          scope?: string;
          objectId?: string;
          recommendation?: string;
        }> = [];

        for (const fdef of FEATURES) {
          if (!fdef.appTypes.includes(app.type)) {
            features.push({
              feature: fdef.feature,
              description: fdef.description,
              status: "n/a",
            });
            continue;
          }
          // Look across schemas; per-app override wins
          let perApp: NonNullable<SettingsListResp["items"]>[number] | undefined;
          let envDefault: NonNullable<SettingsListResp["items"]>[number] | undefined;
          for (const sid of fdef.schemaIds) {
            const items = objectsBySchema.get(sid) ?? [];
            for (const it of items) {
              if (it.scope === app.id) {
                perApp = it;
              } else if (it.scope === "environment" || !it.scope) {
                envDefault = envDefault ?? it;
              }
            }
            if (perApp) break;
          }

          const chosen = perApp ?? envDefault;
          if (!chosen) {
            features.push({
              feature: fdef.feature,
              description: fdef.description,
              status: "missing",
              recommendation: fdef.recommendation,
            });
            continue;
          }
          let enabled: boolean | null = null;
          if (fdef.signal.kind === "boolean") {
            const v = readPath(chosen.value ?? {}, fdef.signal.path);
            enabled = typeof v === "boolean" ? v : null;
          } else if (fdef.signal.kind === "exists") {
            enabled = true;
          }
          features.push({
            feature: fdef.feature,
            description: fdef.description,
            status: perApp ? "configured-explicit" : "configured-via-default",
            enabled,
            scope: chosen.scope,
            objectId: chosen.objectId,
            recommendation: enabled === false ? fdef.recommendation : undefined,
          });
        }

        const missingCount = features.filter((f) => f.status === "missing").length;
        const explicitCount = features.filter((f) => f.status === "configured-explicit").length;
        const disabledCount = features.filter((f) => f.enabled === false).length;

        result.push({
          applicationId: app.id,
          applicationName: app.name,
          applicationType: app.type,
          summary: {
            featuresAudited: features.filter((f) => f.status !== "n/a").length,
            explicitlyConfiguredCount: explicitCount,
            usingDefaultCount: features.filter((f) => f.status === "configured-via-default").length,
            missingCount,
            disabledCount,
          },
          features,
        });
      }

      return {
        content: [
          { type: "text", text: JSON.stringify({ window, totalApps: apps.length, apps: result }, null, 2) },
        ],
      };
    }
  );
}
