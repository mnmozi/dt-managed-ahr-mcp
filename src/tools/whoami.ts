import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import type { DtConfig } from "../config.js";

interface TokenLookupResponse {
  id?: string;
  name?: string;
  owner?: string;
  scopes?: string[];
  enabled?: boolean;
  creationDate?: string;
  expirationDate?: string | null;
  lastUsedDate?: string | null;
  personalAccessToken?: boolean;
  [k: string]: unknown;
}

type LookupOutcome =
  | { configured: false }
  | { configured: true; introspected: true; token: TokenLookupResponse }
  | { configured: true; introspected: false; error: string; status?: number };

/**
 * Scopes the tools in this server rely on, grouped so a reader can match a
 * 403 to the missing grant. Settings 2.0 (/api/v2/settings/*) is governed by
 * settings.read / settings.write; the older Config API v1
 * (/api/config/v1/*: dashboards, maintenance windows v1, conditional naming
 * v1, calculated metrics v1) by ReadConfig / WriteConfig. Both families are
 * used here, which is why "ReadConfig only" tokens produce 403s on most
 * tools.
 */
const SCOPE_GUIDE = {
  read: {
    "settings.read": "every Settings 2.0 read (schemas, objects, dt_get_* schema wrappers)",
    ReadConfig: "Config API v1 reads (dashboards inventory, maintenance windows v1, conditional naming v1, calculated metrics v1, management zones v1 list)",
    "entities.read": "entities, tags, process properties, orphans, tag/naming graph, dt_search_entities",
    "metrics.read": "metric catalog + queries, consumption, cardinality, RUM session counts, dashboard metric pre-validation",
    "events.read": "dt_query_events",
    "problems.read": "dt_get_problem, dt_get_problem_history",
    "logs.read": "dt_search_logs",
    "slo.read": "dt_get_slo",
    "apiTokens.read": "dt_get_api_tokens, dt_whoami introspection",
    "auditLogs.read": "dt_get_audit_log_entries",
    "oneAgents.read": "dt_get_oneagent_versions, dt_get_oneagent_module_status",
    "activeGates.read": "dt_get_activegate_versions",
    InstallerDownload: "per-OS 'latest version' lookups (Deployment API) used by the OneAgent/ActiveGate audits",
    "extensions.read": "dt_get_extensions, dt_get_extension*",
    "extensionConfigurations.read": "dt_list/get_extension_monitoring_config*",
    "extensionEnvironment.read": "dt_get_extension_environment_config",
    "syntheticLocations.read / ReadSyntheticData": "dt_get_synthetic_monitors (v2 / v1)",
    DTAQLAccess: "dt_query_usql",
  },
  write: {
    "settings.write": "dt_validate/create/update/delete_settings",
    WriteConfig: "dt_create/update/delete_dashboard",
    "entities.write": "dt_add_tag, dt_remove_tag, dt_apply_pg_naming_rule, dt_apply_host_clarifying_tag",
    "metrics.ingest": "dt_ingest_metric",
    "logs.ingest": "dt_ingest_logs",
    "events.ingest": "dt_post_event",
    "bizevents.ingest": "dt_ingest_bizevent",
    "problems.write": "dt_close_problem, dt_comment_problem",
    "apiTokens.write": "dt_create_token, dt_delete_token",
    "slo.write": "dt_create/update/delete_slo",
    "ExternalSyntheticIntegration / WriteSyntheticData": "dt_create/update/delete_synthetic_monitor",
    "extensionConfigurations.write": "dt_create/update/delete_extension_monitoring_config",
    "extensionEnvironment.write": "dt_update_extension_environment_config",
  },
};

async function introspect(
  client: DtClient,
  tokenToInspect: string | null,
  authCandidates: Array<string | null>
): Promise<LookupOutcome> {
  if (!tokenToInspect) return { configured: false };
  let last: { error: string; status?: number } = { error: "not attempted" };
  for (const auth of authCandidates) {
    if (!auth) continue;
    try {
      const { data } = await client.lookupToken<TokenLookupResponse>(tokenToInspect, auth);
      return { configured: true, introspected: true, token: data };
    } catch (err) {
      if (err instanceof DtApiError) {
        last = { error: err.body.slice(0, 300), status: err.status };
        // 401/403: this auth token can't call lookup — try the next candidate.
        if (err.status === 401 || err.status === 403) continue;
        break;
      }
      last = { error: err instanceof Error ? err.message : String(err) };
      break;
    }
  }
  return { configured: true, introspected: false, ...last };
}

function scopeSummary(outcome: LookupOutcome): string[] | undefined {
  return outcome.configured && outcome.introspected ? outcome.token.scopes : undefined;
}

/**
 * Reports the MCP's effective configuration AND introspects the configured
 * tokens (read + write) so a later 403 can be matched to a missing scope.
 * Each token is looked up with itself as the auth token first (a token may
 * introspect itself when it has apiTokens.read) and with the other token as
 * a fallback. Token VALUES are never included in the output or the logs.
 */
export function registerWhoami(server: McpServer, client: DtClient, cfg: DtConfig): void {
  server.registerTool(
    "dt_whoami",
    {
      description:
        "Report the MCP's effective configuration (cluster URL, env ID, TLS verify, write mode, cluster-token availability) AND introspect the configured read token and write token (POST /api/v2/apiTokens/lookup): name, owner, scopes, expiration, last-used. Also returns a scope→tool guide so a 403 can be matched to the missing grant. Run this in Phase 0 of any AHR. Token values are never returned.",
      inputSchema: {},
    },
    async () => {
      const { read, write, clusterConfigured } = client.tokens;
      const [readTok, writeTok] = await Promise.all([
        introspect(client, read, [read, write]),
        introspect(client, write, [write, read]),
      ]);

      const readScopes = scopeSummary(readTok);
      const writeScopes = scopeSummary(writeTok);
      const missingRead = readScopes
        ? Object.keys(SCOPE_GUIDE.read).filter((s) => !s.includes("/") && !readScopes.includes(s))
        : undefined;
      const missingWrite =
        writeScopes && write
          ? Object.keys(SCOPE_GUIDE.write).filter((s) => !s.includes("/") && !writeScopes.includes(s))
          : undefined;

      const result = {
        config: {
          clusterUrl: cfg.clusterUrl,
          envId: cfg.envId,
          tlsVerify: cfg.tlsVerify,
          writeEnabled: Boolean(write),
          auditDir: write ? cfg.auditDir : undefined,
          clusterTokenConfigured: clusterConfigured,
          engineBin: process.env.DT_ENGINE_BIN?.trim() || "dt-engine (PATH lookup)",
        },
        readToken: readTok,
        writeToken: writeTok,
        scopeGaps: {
          readTokenMissing: missingRead,
          writeTokenMissing: missingWrite,
          note:
            "A missing scope only matters for the tools that need it (see scopeGuide). Cluster tokens (DT_CLUSTER_TOKEN) cannot be introspected through the environment API.",
        },
        scopeGuide: SCOPE_GUIDE,
        notes: [
          "If a token shows introspected:false with status 403, the token works for other APIs but lacks apiTokens.read — expected for least-privilege tokens; cross-check scopes manually in the UI.",
          "Settings 2.0 reads need settings.read, NOT ReadConfig. ReadConfig/WriteConfig only cover the Config API v1 surfaces (dashboards, v1 maintenance windows, v1 conditional naming, v1 calculated metrics).",
          "Engine-backed tools (dt_run_checks, dt_get_tag_snapshot, dt_audit_*, dt_get_oneagent_versions, dt_get_activegate_versions, dt_get_api_tokens) additionally need the dt-engine binary (DT_ENGINE_BIN).",
        ],
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
