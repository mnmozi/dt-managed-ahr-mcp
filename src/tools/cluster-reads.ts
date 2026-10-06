import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { textResult } from "../helpers/tool-result.js";
import {
  CLUSTER_V1 as V1,
  CLUSTER_V2 as V2,
  clusterRead,
  isClusterTokenMissing,
  NO_CLUSTER_TOKEN,
  redactSecrets,
  type ClusterEndpoint,
} from "../helpers/cluster-read.js";

/**
 * Read-only Cluster Management API surface for Dynatrace Managed. Paths
 * come from the cluster's own OpenAPI specs (/api/v1.0/onpremise/spec3.json,
 * /api/cluster/v2/spec3.json), verified live on 1.346. Every tool answers
 * available:false with a hint when no cluster token is configured; the
 * raw mutating tools keep refusing these paths (cluster-deny-list).
 */

function register(
  server: McpServer,
  client: DtClient,
  name: string,
  description: string,
  endpoints: ClusterEndpoint[]
): void {
  server.registerTool(name, { description, inputSchema: {} }, async () => {
    const res = await clusterRead(client, endpoints);
    return textResult(res, !res.available || res.surfaceStatus === "SURFACE_MISSING");
  });
}

export function registerClusterReads(server: McpServer, client: DtClient): void {
  register(
    server,
    client,
    "dt_cluster_get_overview",
    "Managed cluster health + topology (cluster token): node runtime state and build version per node, node roles (webUI/agent traffic, datacenter), cluster UUID/name, maintenance mode, product version, upgrade state and staged installer files, Elasticsearch upgrade status + outdated indices, and every environment on the cluster (state, tags, quotas). Flag: any node not RUNNING, single-node cluster (no HA — ES health will be YELLOW by design), maintenance mode left on, environments DISABLED, ES outdated indices, upgrade state stuck.",
    [
      { label: "nodes", path: `${V1}/cluster` },
      { label: "nodeConfiguration", path: `${V1}/cluster/configuration` },
      { label: "metadata", path: `${V1}/cluster/metadata` },
      { label: "maintenanceMode", path: `${V1}/cluster/maintenance` },
      { label: "productVersion", path: `${V1}/nodeManagement/productVersion` },
      { label: "thisNodeStatus", path: `${V1}/nodeManagement/nodeServerStatus` },
      { label: "upgradeState", path: `${V1}/upgradeManagement/clusterUpgradeStartupState` },
      { label: "stagedInstallers", path: `${V1}/upgradeManagement/installationFiles` },
      { label: "elasticsearchUpgradeStatus", path: `${V1}/elastic/upgradeStatus` },
      { label: "elasticsearchOutdatedIndices", path: `${V1}/elastic/outdatedIndices` },
      { label: "environments", path: `${V2}/environments`, query: { pageSize: 100 } },
    ]
  );

  register(
    server,
    client,
    "dt_cluster_get_activegates",
    "Cluster-wide ActiveGate inventory (cluster token): every AG across all environments with version, type, hostname, environments served, network zone, OS, autoUpdateStatus, offlineSince, enabled modules; plus cluster-level auto-update config, token-enforcement state, and running update jobs. The environment-scoped dt_get_activegate_versions sees only one environment. Flag: offlineSince != null, autoUpdateStatus != UP2DATE, AGs behind the cluster version, AGs serving no environment, token enforcement disabled.",
    [
      { label: "activeGates", path: `${V2}/activeGates` },
      { label: "autoUpdateConfig", path: `${V2}/activeGates/autoUpdate`, optional: true },
      { label: "tokenEnforcement", path: `${V2}/activeGates/tokenEnforcement`, optional: true },
      { label: "updateJobs", path: `${V2}/activeGates/updateJobs`, optional: true },
    ]
  );

  register(
    server,
    client,
    "dt_cluster_get_access_governance",
    "Identity & access posture of the Managed cluster (cluster token): users (id, email, groups), groups (cluster-admin / account-management flags, LDAP/SSO mappings), per-group management-zone permissions per environment, authentication/authorization provider mode (INTERNAL vs LDAP vs SSO, ssoOnly), LDAP connection config (redacted), password policy, SAML SP certificate expiry, active user sessions. Flag: users in no group, more than a handful of cluster admins, groups with MZ permissions across every environment, INTERNAL auth with ssoOnly=false on a production cluster, password policy below 12 chars / no complexity, SAML cert expiring within 90 days, LDAP without secure connection. Contains user emails — handle as personal data.",
    [
      { label: "users", path: `${V1}/users` },
      { label: "groups", path: `${V1}/groups` },
      { label: "groupManagementZonePermissions", path: `${V1}/groups/managementZones` },
      { label: "authenticationMode", path: `${V1}/userRepository/authenticationMode` },
      { label: "ldap", path: `${V1}/userRepository/ldap/connectionConfiguration`, optional: true },
      { label: "passwordPolicy", path: `${V1}/passwordPolicy` },
      { label: "samlServiceProviderCert", path: `${V1}/sso/saml/sp/cert`, optional: true },
      { label: "userSessions", path: `${V2}/userSessions`, optional: true },
    ]
  );

  register(
    server,
    client,
    "dt_cluster_get_platform_settings",
    "Operational configuration of the Managed cluster (cluster token): preferences (certificate management, billing data upload, non-billing data suppression), SMTP (redacted), internet proxy, backup configuration + last status, public endpoints (web UI, additional UI addresses, CDN, beacon forwarder), cluster-wide network zones, synthetic locations/nodes. Flag: backup disabled or never successful, SMTP unconfigured or NO_ENCRYPTION (problem notifications by email silently fail), beacon forwarder / CDN empty while RUM is licensed, network zones enabled but no zone defined, proxy required but absent.",
    [
      { label: "preferences", path: `${V1}/preferences` },
      { label: "smtp", path: `${V1}/smtp` },
      { label: "proxy", path: `${V1}/proxy/configurations`, optional: true },
      { label: "backupConfig", path: `${V1}/backup/config` },
      { label: "backupStatus", path: `${V1}/backup/config/status`, optional: true },
      { label: "webUiAddress", path: `${V1}/endpoint/webUiAddress` },
      { label: "additionalWebUiAddresses", path: `${V1}/endpoint/additionalWebUiAddresses` },
      { label: "cdnAddress", path: `${V1}/endpoint/cdnAddress` },
      { label: "beaconForwarderAddress", path: `${V1}/endpoint/beaconForwarderAddress` },
      { label: "networkZones", path: `${V2}/networkZones`, optional: true },
      { label: "syntheticLocations", path: `${V2}/synthetic/locations`, optional: true },
      { label: "syntheticNodes", path: `${V2}/synthetic/nodes`, optional: true },
    ]
  );

  register(
    server,
    client,
    "dt_cluster_get_license",
    "Cluster license (cluster token): cluster license details and per-environment license totals. Pair with dt_get_consumption_summary (environment meters) in Phase 5: this is the cluster-wide ceiling, that is one environment's spend. Endpoints are optional — absence means this Managed version does not expose them. The hourly usage export (/api/cluster/v2/license/consumption) is a ZIP archive, not a JSON read — download it from the Cluster Management Console if the raw usage is needed.",
    [
      { label: "clusterLicense", path: `${V2}/clusterLicense`, optional: true },
      { label: "environmentTotals", path: `${V2}/clusterLicense/environment/total`, optional: true },
    ]
  );

  server.registerTool(
    "dt_cluster_get_tokens",
    {
      description:
        "Cluster token hygiene (cluster token): lists every cluster-level API token with name, scopes, enabled, expiry, creation/last-used (detail fetched per token, capped), plus ActiveGate tokens. Flag: unnamed tokens (untraceable owner), tokens with no expiration, tokens carrying cluster-admin scopes (ClusterTokenManagement, ServiceProviderAPI, UnattendedInstall), tokens never used. Token values are never exposed — ids only.",
      inputSchema: {
        maxDetails: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe("How many tokens to fetch details for (default 50). 0 = list only."),
      },
    },
    async ({ maxDetails }) => {
      const cap = maxDetails ?? 50;
      let list: { values?: Array<{ id?: string; name?: string }> };
      try {
        list = await client.get(`${V2}/tokens`, { scope: "cluster" });
      } catch (err) {
        if (isClusterTokenMissing(err)) return textResult(NO_CLUSTER_TOKEN, true);
        if (err instanceof DtApiError) {
          return textResult(
            { available: true, surfaceStatus: "SURFACE_MISSING", error: { status: err.status, message: err.body.slice(0, 300) } },
            true
          );
        }
        throw err;
      }
      const ids = (list.values ?? []).filter((t) => t.id);
      const tokens: unknown[] = [];
      const detailErrors: Array<{ id: string; status: number }> = [];
      for (const t of ids.slice(0, cap)) {
        try {
          tokens.push(redactSecrets(await client.get<unknown>(`${V2}/tokens/${encodeURIComponent(t.id!)}`, { scope: "cluster" })));
        } catch (err) {
          if (!(err instanceof DtApiError)) throw err;
          detailErrors.push({ id: t.id!, status: err.status });
        }
      }
      const ag = await clusterRead(client, [
        { label: "activeGateTokens", path: `${V2}/activeGateTokens`, optional: true },
      ]);
      return textResult({
        available: true,
        surfaceStatus: "ok",
        totalTokens: ids.length,
        unnamedTokens: ids.filter((t) => !t.name).length,
        detailsFetched: tokens.length,
        detailsOmitted: Math.max(0, ids.length - cap),
        tokens,
        ...(detailErrors.length ? { detailErrors } : {}),
        activeGateTokens: ag.endpoints?.activeGateTokens,
      });
    }
  );

  server.registerTool(
    "dt_cluster_get_settings",
    {
      description:
        "Cluster-level Settings 2.0 sweep (cluster token): lists every schema the cluster advertises at cluster scope (/api/cluster/v2/settings/schemas — e.g. update windows, password policy, privacy, login screen, token settings, network zones, cluster-events notifications, audit log) and returns all objects per schema. Nothing is hardcoded, so renames can't blind it. Flag: no cluster update window (upgrades land anytime), cluster-events notifications empty (nobody is told about node/upgrade events), audit log off at cluster scope, password policy left at defaults.",
      inputSchema: {
        schemaFilter: z
          .string()
          .optional()
          .describe("Optional case-insensitive substring on schemaId to restrict the sweep."),
      },
    },
    async ({ schemaFilter }) => {
      let inventory: { items?: Array<{ schemaId?: string; latestSchemaVersion?: string }> };
      try {
        inventory = await client.get(`${V2}/settings/schemas`, { scope: "cluster" });
      } catch (err) {
        if (isClusterTokenMissing(err)) return textResult(NO_CLUSTER_TOKEN, true);
        if (err instanceof DtApiError) {
          return textResult(
            { available: true, surfaceStatus: "SURFACE_MISSING", error: { status: err.status, message: err.body.slice(0, 300) } },
            true
          );
        }
        throw err;
      }
      const schemas = (inventory.items ?? [])
        .filter((s): s is { schemaId: string; latestSchemaVersion?: string } => Boolean(s.schemaId))
        .filter((s) => !schemaFilter || s.schemaId.toLowerCase().includes(schemaFilter.toLowerCase()))
        .sort((a, b) => a.schemaId.localeCompare(b.schemaId));
      const perSchema: Array<Record<string, unknown>> = [];
      for (const s of schemas) {
        try {
          const resp = await client.get<{ items?: unknown[]; totalCount?: number }>(`${V2}/settings/objects`, {
            scope: "cluster",
            query: { schemaIds: s.schemaId, pageSize: 500, fields: "objectId,schemaId,scope,summary,value,modified" },
          });
          perSchema.push({
            schemaId: s.schemaId,
            schemaVersion: s.latestSchemaVersion,
            totalCount: resp.totalCount ?? resp.items?.length ?? 0,
            items: redactSecrets(resp.items ?? []),
          });
        } catch (err) {
          if (!(err instanceof DtApiError)) throw err;
          perSchema.push({
            schemaId: s.schemaId,
            schemaVersion: s.latestSchemaVersion,
            error: { status: err.status, message: err.body.slice(0, 200) },
          });
        }
      }
      return textResult({
        available: true,
        surfaceStatus: perSchema.length ? "ok" : "SURFACE_MISSING",
        schemasAdvertised: schemas.length,
        schemasWithObjects: perSchema.filter((p) => (p.totalCount as number) > 0).length,
        schemas: perSchema,
      });
    }
  );
}
