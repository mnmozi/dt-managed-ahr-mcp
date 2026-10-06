# dt-managed-mcp

MCP server for **Dynatrace Managed** aimed at Account Health Reviews (AHR):
the configuration surface (Settings 2.0 + Config API v1) that the upstream
[`dynatrace-managed-mcp`](https://github.com/dynatrace-oss/dynatrace-managed-mcp)
does not expose, engine-backed tag/naming analyzers, and an **optional,
heavily guard-railed write surface** for applying remediations.

The read surface always registers. The write tools register only when
`DT_WRITE_TOKEN` (or `DT_WRITE_TOKEN_FILE`) is set. A handful of analyzers
additionally need the `dt-engine` Go binary (see [Engine](#engine)).

```
npm install && npm run build
node dist/server.js        # stdio MCP server; config via env vars
```

## Contents

- [Configuration](#configuration)
- [Token scopes](#token-scopes)
- [Engine](#engine)
- [Register with Claude Code](#register-with-claude-code)
- [Tool reference](#tool-reference)
- [Write safety model](#write-safety-model)
- [Dashboard pre-validation](#dashboard-pre-validation)
- [Dynatrace Managed specifics this server encodes](#dynatrace-managed-specifics-this-server-encodes)
- [Prompts and resources](#prompts-and-resources)
- [Development](#development)

## Configuration

Everything is env-driven; nothing is hardcoded. `.env.example` lists every
variable with comments.

| Variable | Required | Notes |
|---|---|---|
| `DT_CLUSTER_URL` | yes | e.g. `https://localhost:8080`. No trailing slash, no `/e/<env>`. |
| `DT_ENV_ID` | yes | Environment UUID. |
| `DT_TOKEN` **or** `DT_TOKEN_FILE` | exactly one | Read token (value, or path to a one-line file). |
| `DT_WRITE_TOKEN` / `DT_WRITE_TOKEN_FILE` | optional | **When present, registers the write tools.** Use a separate, narrowly scoped token. |
| `DT_CLUSTER_TOKEN` / `DT_CLUSTER_TOKEN_FILE` | optional | Cluster-scoped reads via `dt_raw_get scope:'cluster'` and the `dt-spec://cluster-v1` resource. |
| `DT_AUDIT_DIR` | optional | Write-tool audit JSONL directory. Default `<cwd>/.audit`, one file per day. |
| `DT_TLS_VERIFY` | optional | `0` disables certificate verification (self-signed clusters). |
| `DT_ENGINE_BIN` | optional | Path to the `dt-engine` binary. Default: `dt-engine` on `PATH`. |
| `DT_BUNDLE_DIR` | optional | Where `dt_run_checks` materializes raw bundles. Default `<cwd>/.bundles`. |
| `DT_GRAPH_CACHE_TTL_MS` | optional | Reuse window for the fetched entity graph across the tag/naming analyzers. Default 600000 (10 min); `0` disables. |
| `DT_HTTP_TIMEOUT_MS` | optional | Per-attempt timeout. Default 60000. |
| `DT_HTTP_MAX_RETRIES` | optional | Retries for GET / read-via-POST on 408/425/429/5xx and network errors. Default 3. Writes never retry. |
| `DT_HTTP_BACKOFF_MS` / `DT_HTTP_MAX_BACKOFF_MS` | optional | Full-jitter exponential backoff, initial / cap. Defaults 1000 / 30000. `Retry-After` is honoured on 429. |
| `DT_LOG_LEVEL` | optional | `trace`, `debug`, `info` (default), `warn`, `error`. Logs are JSONL on stderr; stdout is the MCP transport. |
| `DT_LOG_FILE` / `DT_ENGINE_LOG_FILE` | optional | Mirror all log lines / only engine-subprocess lines to a file. |

## Token scopes

Two API families are used and they have **different** scope models. The
single most common 403 is a token that only has `ReadConfig`:

- **Settings 2.0** (`/api/v2/settings/*`) is governed by `settings.read` /
  `settings.write`.
- **Config API v1** (`/api/config/v1/*`: dashboards, maintenance windows v1,
  conditional naming v1, calculated metrics v1, management-zone list) is
  governed by `ReadConfig` / `WriteConfig`.

`dt_whoami` introspects the read and write tokens and returns a
scope-to-tool guide plus the gaps, so run it first.

**Read token**

| Scope | Needed by |
|---|---|
| `settings.read` | every `dt_get_*` Settings 2.0 wrapper, `dt_list_schemas`, `dt_get_schema`, `dt_list_settings_objects`, `dt_get_settings_object`, `dt_get_recently_changed_settings`, `dt_get_orphan_settings_scopes`, RUM feature matrix |
| `ReadConfig` | `dt_get_dashboards_inventory`, `dt_get_dashboard_context` (MZ list), `dt_get_maintenance_windows` (v1 half), `dt_get_conditional_naming`, `dt_get_calculated_service_metrics` (v1 half), dashboard MZ pre-validation |
| `entities.read` | entities, tags, `dt_get_process_properties`, `dt_get_entity_orphans`, `dt_search_entities`, the tag/naming graph, RUM inventory |
| `metrics.read` | `dt_list_metrics`, `dt_get_metric_metadata`, `dt_query_metrics`, `dt_get_consumption_summary`, `dt_get_service_request_cardinality`, RUM session counts, dashboard metric pre-validation |
| `events.read` / `problems.read` / `logs.read` / `slo.read` | `dt_query_events` / `dt_get_problem*` / `dt_search_logs` / `dt_get_slo` |
| `apiTokens.read` | `dt_get_api_tokens`, `dt_whoami` introspection |
| `auditLogs.read` | `dt_get_audit_log_entries` |
| `oneAgents.read` / `activeGates.read` | `dt_get_oneagent_versions`, `dt_get_oneagent_module_status` / `dt_get_activegate_versions` |
| `InstallerDownload` | the per-OS "latest available version" lookups (Deployment API) inside the OneAgent / ActiveGate audits. Without it the audits still run but every host lands in `…WithoutOsLatestReference`. |
| `extensions.read`, `extensionConfigurations.read`, `extensionEnvironment.read` | `dt_get_extensions`, `dt_get_extension*` |
| `ReadSyntheticData` / `ExternalSyntheticIntegration` | `dt_get_synthetic_monitors` |
| `DTAQLAccess` | `dt_query_usql` |
| `DataExport` | `dt_raw_get /api/v1/config/clusterversion` (cluster version) |

**Write token** (grant only what you will actually use)

| Scope | Needed by |
|---|---|
| `settings.write` | `dt_validate_settings`, `dt_create_settings`, `dt_update_settings`, `dt_delete_settings` |
| `WriteConfig` | `dt_create_dashboard`, `dt_update_dashboard`, `dt_delete_dashboard` |
| `entities.write` | `dt_add_tag`, `dt_remove_tag`, `dt_apply_pg_naming_rule`, `dt_apply_host_clarifying_tag` |
| `metrics.ingest` / `logs.ingest` / `events.ingest` / `bizevents.ingest` | `dt_ingest_metric` / `dt_ingest_logs` / `dt_post_event` / `dt_ingest_bizevent` |
| `problems.write` | `dt_close_problem`, `dt_comment_problem` |
| `apiTokens.write` | `dt_create_token`, `dt_delete_token` |
| `slo.write` | `dt_create_slo`, `dt_update_slo`, `dt_delete_slo` |
| `ExternalSyntheticIntegration` | `dt_create/update/delete_synthetic_monitor` |
| `extensionConfigurations.write`, `extensionEnvironment.write` | extension monitoring / environment config writes |

The raw escape hatches (`dt_raw_post/put/patch/delete`) use whatever the
write token carries; keep that token narrow.

## Engine

These tools delegate all analysis to the `dt-engine` Go binary (a sibling
repo, `dt-managed-engine`) spawned once per session over stdio:

`dt_list_checks`, `dt_run_checks`, `dt_get_tag_snapshot`,
`dt_extract_tag_signals`, `dt_simulate_tag_strategy`,
`dt_audit_process_group_naming`, `dt_audit_host_naming`,
`dt_audit_host_groups`, `dt_get_oneagent_versions`,
`dt_get_activegate_versions`, `dt_get_api_tokens`.

Set `DT_ENGINE_BIN` to the binary path (or put `dt-engine` on `PATH`). When
the engine is missing these tools return `{ available: false, hint }` with
`isError: true`; nothing else in the server depends on it. The `ahr` prompt
carries an explicit fallback rule for that case.

```bash
cd ../dt-managed-engine && go build -o /usr/local/bin/dt-engine ./cmd/dt-engine
```

## Register with Claude Code

```bash
claude mcp add dt-managed \
  --scope user \
  --env DT_CLUSTER_URL=https://localhost:8080 \
  --env DT_ENV_ID=<env-uuid> \
  --env DT_TOKEN_FILE=$HOME/.dt/localhost.token \
  --env DT_WRITE_TOKEN_FILE=$HOME/.dt/localhost.write.token \
  --env DT_ENGINE_BIN=/usr/local/bin/dt-engine \
  --env DT_TLS_VERIFY=0 \
  -- node /absolute/path/to/dt-managed-mcp/dist/server.js
```

Or directly in `~/.claude.json` / project `.mcp.json`:

```json
{
  "mcpServers": {
    "dt-managed": {
      "command": "node",
      "args": ["/absolute/path/to/dt-managed-mcp/dist/server.js"],
      "env": {
        "DT_CLUSTER_URL": "https://localhost:8080",
        "DT_ENV_ID": "<env-uuid>",
        "DT_TOKEN_FILE": "/Users/you/.dt/localhost.token",
        "DT_WRITE_TOKEN_FILE": "/Users/you/.dt/localhost.write.token",
        "DT_ENGINE_BIN": "/usr/local/bin/dt-engine",
        "DT_TLS_VERIFY": "0"
      }
    }
  }
}
```

To run **read-only**, omit `DT_WRITE_TOKEN*`: the write tools are not
registered at all. The `ahr` prompt refers to this server as `dt-managed`;
if you register it under another name, nothing breaks, the tool names are
what matter.

## Tool reference

### Bootstrap and escape hatches

| Tool | Purpose |
|---|---|
| `dt_whoami` | Effective config + introspection of the read **and** write tokens (name, scopes, expiry, last use), scope gaps, scope-to-tool guide. Run first. |
| `dt_list_schemas` / `dt_get_schema` | Settings 2.0 schema discovery; `dt_get_schema` returns a flattened field list (types, enums, defaults) for building payloads. |
| `dt_list_settings_objects` / `dt_get_settings_object` | Generic Settings 2.0 object listing (auto-paginated) and single-object read. |
| `dt_raw_get` | GET any env-scoped path (`scope:'cluster'` for `/api/v1.0/onpremise/*` with the cluster token). |

### Settings 2.0 configuration reads

Each wrapper probes several candidate schema ids (ids drift across Managed
versions) and reports per-schema availability instead of failing.

| Tool | Schemas |
|---|---|
| `dt_get_auto_tags` | `builtin:tags.auto-tagging` |
| `dt_get_management_zones` | `builtin:management-zones` |
| `dt_get_pg_detection_rules` | PG advanced detection rules + detection flags |
| `dt_get_service_detection_rules` | v1 full/external web service/request detection |
| `dt_get_v2_service_detection` | v2 service detection, splitting, endpoint, URL-path pattern rules |
| `dt_get_request_naming` | request naming + request attributes |
| `dt_get_naming_rules` | Settings 2.0 conditional naming (PG / host / service candidates) |
| `dt_get_failure_detection` | rulesets, environment rules, per-protocol parameters |
| `dt_get_trace_sampling_and_ingest` / `dt_get_span_capturing` | URL/RPC sampling, ingest control, muted requests / span capturing + attributes |
| `dt_get_service_anomaly_detection` / `dt_get_anomaly_detection` | service AD / metric events, infra, apps, DB, frequent issues, k8s |
| `dt_get_process_monitoring_rules` | process-monitoring scope (host-unit + DDU driver) |
| `dt_get_log_ingestion_rules` / `dt_get_log_monitoring_extras` | log storage, DPP, metric extraction, masking / feature flags |
| `dt_get_network_zones` | OneAgent to ActiveGate routing |
| `dt_get_ownership_teams`, `dt_get_alerting_profiles`, `dt_get_problem_notifications`, `dt_get_audit_log_settings` | governance surfaces |
| `dt_get_cloud_integration`, `dt_get_appsec_config`, `dt_get_rum_config`, `dt_get_business_events`, `dt_get_custom_services_and_key_requests`, `dt_get_opentelemetry_config`, `dt_get_release_monitoring`, `dt_get_oneagent_features_and_enrichment` | integration, AppSec, RUM, BizEvents, OTel, release, OneAgent feature surfaces |

### Infrastructure and rollout

| Tool | Purpose |
|---|---|
| `dt_get_oneagent_versions` (engine) | Version / autoUpdate / monitoring-mode distribution, faulty versions, per-OS "behind latest" using the Deployment API reference version. |
| `dt_get_oneagent_module_status` | Per-host module on/off, FULL_STACK hosts without the log module, hosts running a deep-monitorable technology with no enabled module (joined from HOST `softwareTechnologies`), misconfigured modules. |
| `dt_get_activegate_versions` (engine) | AG versions, types, connection status, capability and network-zone maps, misconfigured modules, "behind latest". |
| `dt_get_maintenance_windows` | Settings 2.0 and Config v1 surfaces together. |
| `dt_get_extensions`, `dt_get_extension`, `dt_list_extension_monitoring_configs`, `dt_get_extension_monitoring_config`, `dt_get_extension_monitoring_config_status`, `dt_get_extension_environment_config` | Extensions 2.0 inventory, version sprawl, per-config status. |
| `dt_get_synthetic_monitors` | Monitor inventory summary. |

### Entities, tags, naming hygiene

| Tool | Purpose |
|---|---|
| `dt_list_tags_for_entity` | `/api/v2/tags` with context (manual vs auto vs infrastructure). |
| `dt_search_entities` | Entity selector search, auto-paginated, projectable fields. |
| `dt_get_process_properties` | Categorized "what you can rule on" view of a PG / PGI / HOST with a stability rating per property. |
| `dt_get_entity_orphans` | Services without a PG/PGI, hosts without a monitored PG, zombie PGs, inactive hosts. Relationship matching is by target type across both relationship maps. |
| `dt_get_orphan_settings_scopes` | Settings objects scoped to entities that 404 over a 30-day lookback; non-404 failures are reported as unverified, not as orphans. |
| `dt_get_conditional_naming` | Config v1 conditional naming rules. |
| `dt_get_recently_changed_settings` | Config churn by schema over N days. |

### Engine-backed analyzers (tag strategy and naming)

| Tool | Purpose |
|---|---|
| `dt_list_checks` / `dt_run_checks` | Deterministic checks: materialize a raw bundle from live reads, hand it to the engine, return findings with evidence and fix templates. |
| `dt_get_tag_snapshot` | Round 1: per-type counts, per-key taxonomy and value-format judgment, key similarity clusters, low-tag entities with subgraph, propagation hints. |
| `dt_extract_tag_signals` | Round 2a: candidate values per entity for target keys from properties, cloud tags, k8s labels and graph neighbours, with consensus picks. |
| `dt_simulate_tag_strategy` | Round 2b: coverage a proposed per-key extraction recipe would reach, plus the uncovered entities. |
| `dt_audit_process_group_naming` / `dt_audit_host_naming` / `dt_audit_host_groups` | Generic-name detection with ranked candidates bucketed as `high_confidence`, `ambiguous`, `no_signal`; host-group coverage findings. |
| `dt_export_hostgroup_remediation` | Pure text generation of `oneagentctl --set-host-group` commands (plus an Ansible inventory fragment) for operator-picked findings. Never executes anything. |
| `dt_get_api_tokens` (engine) | Token security audit: no expiry, expired, never used, stale, high privilege, disabled. |

The entity graph the six tag/naming tools share is fetched once and reused
for `DT_GRAPH_CACHE_TTL_MS`; tag writes invalidate it.

### Observability data

| Tool | Purpose |
|---|---|
| `dt_list_metrics` / `dt_get_metric_metadata` / `dt_query_metrics` | Metric catalog, single-metric metadata (`{ exists: false }` on 404), metric query with a flattened per-series summary. |
| `dt_get_dashboard_context` / `dt_get_dashboards_inventory` | One-call pre-flight bundle for dashboard building (MZs, entity types, metric prefix summary + sample) / Config v1 dashboard inventory. |
| `dt_search_logs` | `GET /api/v2/logs/search` (Log Monitoring Classic), sliced pagination via `nextSliceKey`, distinct extracted attribute keys. |
| `dt_query_events` | `/api/v2/events` search with per-type counts. |
| `dt_get_problem` / `dt_get_problem_history` | Single problem detail / 30-day MTTR, recurring root entities, stuck-open problems. |
| `dt_get_slo` | Single SLO read (companion to the SLO write tools). |
| `dt_get_service_request_cardinality` | Distinct request names per service (with resolved names) and top-N by calls; flags missing request-naming rules. |
| `dt_get_calculated_service_metrics` | Settings 2.0 candidates and Config v1. |
| `dt_get_consumption_summary` | Discovers this tenant's `builtin:billing.*` metrics, queries each merged across dimensions, groups totals into host-unit / DDU pool / synthetic / session categories. |
| `dt_get_audit_log_entries` | `/api/v2/auditlogs` with per-user / per-category summary. |
| `dt_get_rum_app_inventory` / `dt_get_rum_app_feature_matrix` | RUM app discovery with session counts / per-app audit across ~25 RUM features. |
| `dt_query_usql` | USQL over RUM session data, rows flattened. |
| `dt_get_oauth_clients` | `/api/v2/oauthClients`; expected to report `available: false` on Managed. |
| `dt_get_trace` | **Experimental probe.** `POST /api/v2/spans/query` is a Grail/SaaS capability; Managed clusters return `available: false`. |

### Write tools (registered only with `DT_WRITE_TOKEN`)

Every mutating tool requires the literal `confirm: "yes"` and appends a JSONL
audit record (success or failure) under `DT_AUDIT_DIR`.

| Tool | Endpoint | Guard rails |
|---|---|---|
| `dt_validate_settings` | `POST /api/v2/settings/objects?validateOnly=true` | Dry run, no confirm needed. |
| `dt_create_settings` | `POST /api/v2/settings/objects` | Pre-validate, same-name collision check for known schemas, payload-fingerprint duplicate detection (10 min). |
| `dt_update_settings` | `PUT /api/v2/settings/objects/{id}` | Full replacement; prior object captured in the audit row so it is reversible; `dryRun` maps to `validateOnly`. |
| `dt_delete_settings` | `DELETE /api/v2/settings/objects/{id}` | Pre-fetch, `expectedSchemaId` check, `expectedName` **required** for high-blast schemas (alerting profiles, MZs, notifications, auto-tags, metric events, …), prior object in audit. `force` needs `acknowledgeForce`. |
| `dt_ingest_metric` / `dt_ingest_logs` / `dt_ingest_bizevent` | `/api/v2/metrics/ingest`, `/logs/ingest`, `/bizevents/ingest` | Client-side validation of what Dynatrace otherwise drops silently behind a 202. |
| `dt_post_event` | `POST /api/v2/events/ingest` | Typed event kinds. |
| `dt_create_dashboard` / `dt_update_dashboard` / `dt_delete_dashboard` | `/api/config/v1/dashboards` | Tile-type allow-list, metric and MZ existence pre-validation, fingerprint dedup; delete requires `expectedName`. |
| `dt_add_tag` / `dt_remove_tag` | `/api/v2/tags` | Blast-radius pre-check: refuses 0 matches, needs `expectedMatchCount` above 10, `acknowledgeMassChange` above 1000, 5 % drift tolerance; preview of matched entities. |
| `dt_apply_pg_naming_rule` / `dt_apply_host_clarifying_tag` | `POST /api/v2/tags` (`name:<value>`) | Decision lattice enforced in code: the AI cannot upgrade a confidence bucket or invent names outside the engine's candidates; `operator_override` is allowed but logged loudly; full provenance in the audit row. |
| `dt_close_problem` / `dt_comment_problem` | `/api/v2/problems/{id}/close`, `/comments` | — |
| `dt_create_token` / `dt_delete_token` | `/api/v2/apiTokens` | Token value returned once; **redacted in the audit log**. |
| `dt_create_slo` / `dt_update_slo` / `dt_delete_slo` | `/api/v2/slo` | Safe delete with `expectedName`. |
| `dt_create_synthetic_monitor` / `dt_update_synthetic_monitor` / `dt_delete_synthetic_monitor` | `/api/v1/synthetic/monitors` | Safe delete with `expectedName`. |
| `dt_create_extension_monitoring_config` / `dt_update_extension_monitoring_config` / `dt_delete_extension_monitoring_config` / `dt_update_extension_environment_config` | `/api/v2/extensions/{name}/…` | Safe delete. |
| `dt_raw_post` / `dt_raw_put` / `dt_raw_patch` / `dt_raw_delete` | any env-scoped path | Cluster-admin path deny-list (no override). Prefer a typed tool. |

Auto-tag rules, MZs, detection rules, naming rules and alerting profiles all
live in Settings 2.0, so they go through the generic
`dt_get_schema` → `dt_validate_settings` → `dt_create_settings` /
`dt_update_settings` → `dt_delete_settings` path. Common schema ids:
`builtin:tags.auto-tagging`, `builtin:management-zones`,
`builtin:process-group.advanced-detection-rule`,
`builtin:service-detection.full-web-request`, `builtin:service-detection-rules`,
`builtin:service.request-naming`, `builtin:conditional-naming.processgroup` /
`.host` / `.service`, `builtin:alerting.profile`,
`builtin:logmonitoring.log-dpp-rules`, `builtin:logmonitoring.log-events`.

## Write safety model

1. **Explicit confirm** on every mutation (`confirm: "yes"`), schema-enforced.
2. **Audit everything**: one JSONL row per attempt with request, response or
   error, object/schema ids, payload fingerprint and (for naming writes) the
   decision provenance. Token values are redacted; otherwise request bodies
   are stored verbatim, so keep secrets out of raw-tool payloads.
3. **Fail closed on pre-checks**: if pre-validation or the blast-radius query
   itself fails, the write is refused rather than attempted blind.
4. **Reversibility**: deletes and updates capture the prior object; the
   response says how to roll back.
5. **No cluster-admin writes**: the raw tools refuse `/api/v1.0/onpremise/*`
   and cluster-configuration prefixes outright.
6. **No remote execution**: host-group remediation is emitted as text for the
   operator; the server never runs commands on hosts.

## Dashboard pre-validation

`POST /api/config/v1/dashboards` accepts dashboards referencing metrics or
management zones that do not exist on the tenant; the failure only surfaces
as an empty tile in the UI. `dt_create_dashboard` and `dt_update_dashboard`
therefore walk the payload first and check:

1. **Tile types** against an allow-list with "did you mean" suggestions
   (`DATA_EXPLORE` → `DATA_EXPLORER`) and per-type required fields.
2. **Metric references** in `tile.queries[].metric`,
   `tile.queries[].metricSelector` (transforms stripped),
   `tile.filterConfig.chartConfig.series[].metric` and
   `tile.customChartingItems[].metricExpression`, each confirmed via
   `GET /api/v2/metrics/{key}`; on 404 up to five sibling keys are suggested.
3. **Management-zone ids** in `dashboardMetadata.dashboardFilter` and per-tile
   `tileFilter`.

Recommended flow: `dt_get_dashboard_context` → (optional) `dt_list_metrics`
for one family → build the JSON → `dt_create_dashboard`. For a custom metric
you are about to ingest, `dt_ingest_metric` one point first so the catalog
entry exists, or pass `validateMetrics: false`.

## Dynatrace Managed specifics this server encodes

- **Settings 2.0 vs Config API v1 scopes** differ (`settings.*` vs
  `ReadConfig`/`WriteConfig`); both are needed for a full AHR.
- **Deployment API OS names**: inventories report `LINUX`/`WINDOWS`/`AIX`/…,
  the Deployment API wants `unix`/`windows`/`aix`/`solaris`/`zos` (ActiveGate:
  `unix`/`windows` only). The version audits map between them and need
  `InstallerDownload`. On Managed 1.344+ the "latest" endpoint returns the
  environment's configured auto-update target version when one is pinned.
- **`/api/v2/apiTokens` `fields` is additive**: extra fields must be requested
  as `+scopes,+lastUsedDate,…`; bare names are rejected.
- **Log search** is `GET /api/v2/logs/search` with `nextSliceKey` paging and
  serves Log Monitoring Classic only. Records carry extracted attributes under
  `additionalColumns`.
- **No spans-query REST API** on Managed (Grail only); `dt_get_trace` is a probe.
- **`/api/v2/oauthClients`** is an account-management (SaaS) surface; expect
  `available: false`.
- **Relationship names vary** between Managed versions (`runsOn` vs
  `runsOnProcessGroupInstance`, …); every relationship-aware tool matches on
  the target entity type across both `fromRelationships` and
  `toRelationships` instead of hard-coding names.
- **Schema ids drift**; the Settings 2.0 wrappers probe several candidates
  and report per-schema availability.
- **Host-group membership cannot be changed through the API**; it is set by
  `oneagentctl` on the host, hence the generated-commands tool.
- **Billing metric keys differ by version and license**; consumption is
  discovered from the catalog rather than hard-coded.

## Prompts and resources

| Prompt | Purpose |
|---|---|
| `ahr` | Phased Account Health Review (bootstrap, hosts, PGs, MZs, maintenance windows, Davis health, services, alerting, governance, integrations, RUM, cost), then strategy artifacts and a machine-actionable remediation backlog for the write tools. Discovers the de-facto tag taxonomy from live data; stops after each phase. Includes an engine-unavailable fallback rule. Args: `accountAlias` (required), `expectedKeys` (optional overlay). |

| Resource | Contents |
|---|---|
| `dt-spec://env-v2` | OpenAPI 3 spec for `/api/v2/*`. |
| `dt-spec://env-config-v1` | OpenAPI 3 spec for `/api/config/v1/*`. |
| `dt-spec://cluster-v1` | OpenAPI 3 spec for `/api/v1.0/onpremise/*` (needs the cluster token). |

Specs are cached under `.cache/specs/<cluster-host>/` for 24 h.

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest (unit tests for helpers, client retry policy, logger)
npm run build          # emit dist/

# read-only connectivity smoke test
DT_CLUSTER_URL=https://localhost:8080 DT_ENV_ID=<env-uuid> \
DT_TOKEN_FILE=~/.dt/localhost.token DT_TLS_VERIFY=0 npm run smoke

# naming pipeline end-to-end (needs the engine)
DT_ENGINE_BIN=/usr/local/bin/dt-engine ... npm run smoke:naming
```

Audit-log rows (`.audit/<YYYY-MM-DD>.jsonl`) have a stable shape:
`timestamp, tool, method, path, validateOnly, schemaId?, scope?, objectId?,
status, requestBody?, responseBody?, error?, payloadFingerprint?,
namingDecision?`.

## Relationship to the upstream MCP

`dynatrace-oss/dynatrace-managed-mcp` covers observability data (entities,
problems, events, SLOs, metrics, logs, security problems) and exposes no
configuration tools. This server is complementary: register both and an AHR
agent can take entity inventory from either side, configuration from here,
and apply remediations through the write tools in the same session. The
`ahr` prompt names the upstream tools where they are the better fit and the
`dt_` equivalent to use when upstream is not registered.
