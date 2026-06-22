# dt-managed-mcp

Unified MCP server for Dynatrace Managed. Wraps the **Settings 2.0** and
**config** APIs that the upstream
[`dynatrace-managed-mcp`](https://github.com/dynatrace-oss/dynatrace-managed-mcp)
does not expose, plus an **optional write surface** for applying remediations,
ingesting custom metrics, and building dashboards.

Previously two repos: `dt-managed-ahr-mcp` (read) + `dt-managed-write-mcp`
(write). Merged here. The read surface always works; the write tools register
only when `DT_WRITE_TOKEN` (or `DT_WRITE_TOKEN_FILE`) is set, so existing
read-only usage is unchanged.

## Read tools

| Tool | Purpose |
|---|---|
| `dt_whoami` | Cluster URL + env id + TLS verify + token introspection (name, scopes, expiration). Run first in any AHR. |
| `dt_get_oneagent_versions` | OneAgent rollout summary (versions, autoUpdate, monitoring mode, faulty count, hosts behind latest). |
| `dt_get_oneagent_module_status` | Per-host module on/off + detected-tech-not-monitored gap. |
| `dt_get_oneagent_features_and_enrichment` | OneAgent feature flags + metadata/context enrichment + log-agent feature flags. |
| `dt_get_activegate_versions` | ActiveGate summary (versions, type, autoUpdate, connection status, misconfigured modules). |
| `dt_get_maintenance_windows` | MWs from both Settings 2.0 and Config v1 surfaces. |
| `dt_get_consumption_summary` | Curated billing/DDU metrics over a window. |
| `dt_list_schemas` | List all Settings 2.0 schemas available on the environment. |
| `dt_get_schema` | Fetch one schema's field structure, types, enums, defaults. |
| `dt_list_settings_objects` | Paginate Settings 2.0 objects for one or more `schemaIds`. |
| `dt_get_settings_object` | Fetch one object by `objectId`. |
| `dt_raw_get` | Escape hatch — GET any API path (env-scoped by default, `scope:'cluster'` for cluster paths). |
| `dt_list_tags_for_entity` | `/api/v2/tags` with an `entitySelector`; returns each tag's `context` (manual vs auto vs infrastructure). |
| `dt_get_process_properties` | Categorizes a PG / PGI / HOST entity into env vars, JVM args, exe info, listening ports, k8s/AWS metadata + stability ratings. |
| `dt_get_auto_tags` | All `builtin:tags.auto-tagging` objects. |
| `dt_get_management_zones` | All `builtin:management-zones` objects. |
| `dt_get_pg_detection_rules` | Process-group advanced detection rules + detection flags. |
| `dt_get_service_detection_rules` | v1 service-detection.* schemas. |
| `dt_get_v2_service_detection` | v2 surface for k8s + OTel. |
| `dt_get_failure_detection` | Failure detection rulesets + env rules + per-protocol params. |
| `dt_get_trace_sampling_and_ingest` | URL/RPC sampling, trace ingest control, muted requests. |
| `dt_get_service_anomaly_detection` | `builtin:anomaly-detection.services`. |
| `dt_get_anomaly_detection` | Full AD surface beyond services. |
| `dt_get_process_monitoring_rules` | Process-monitoring scope schemas (DDU + host-unit cost). |
| `dt_get_log_ingestion_rules` | Log ingestion / processing / storage / metric-extraction / masking. |
| `dt_get_network_zones` | `builtin:network-zones` — OneAgent → ActiveGate routing. |
| `dt_get_ownership_teams` | `builtin:ownership.teams` directory. |
| `dt_get_alerting_profiles` | `builtin:alerting.profile`. |
| `dt_get_problem_notifications` | Notification integrations. |
| `dt_get_audit_log_settings` | `builtin:audit-log` config. |
| `dt_get_audit_log_entries` | `/api/v2/auditlogs` recent activity + summary. |
| `dt_get_extensions` | Installed Extensions 2.0 + version sprawl detection. |
| `dt_get_synthetic_monitors` | `/api/v2/synthetic/monitors` summary. |
| `dt_get_dashboards_inventory` | `/api/config/v1/dashboards` listing + owner stats. |
| `dt_get_cloud_integration` | AWS / Azure / GCP / K8s / CloudFoundry / VMware schemas. |
| `dt_get_appsec_config` | Vulnerability + RAP + code-level + alerting + notification AppSec schemas. |
| `dt_get_rum_config` | Comprehensive RUM Settings 2.0 sweep. |
| `dt_get_rum_app_inventory` | RUM application entities with per-app session count. |
| `dt_get_rum_app_feature_matrix` | Per-app audit across ~25 RUM features. |
| `dt_get_business_events` | BizEvents incoming + processing pipelines. |
| `dt_get_custom_services_and_key_requests` | Custom service definitions + key-request subscriptions. |
| `dt_get_opentelemetry_config` | OTel ingestion settings + span schemas. |
| `dt_get_release_monitoring` | Release/deployment events config. |
| `dt_get_log_monitoring_extras` | Log monitoring meta surfaces. |
| `dt_get_api_tokens` | `/api/v2/apiTokens` inventory + security findings. |
| `dt_get_oauth_clients` | `/api/v2/oauthClients` inventory. |
| `dt_get_span_capturing` | Span capturing + attribute extraction schemas. |
| `dt_get_problem_history` | 30d problem analysis (MTTR, recurring root entities, stuck-open). |
| `dt_get_orphan_settings_scopes` | Settings 2.0 objects scoped to entity ids that no longer exist. |
| `dt_get_entity_orphans` | SERVICE-without-PG, HOST-without-monitored-PG, zombie-PG, inactive-host. |
| `dt_get_recently_changed_settings` | Settings 2.0 objects modified in last N days. |
| `dt_get_calculated_service_metrics` | Calculated service metric definitions. |
| `dt_get_service_request_cardinality` | Distinct request-name count + top-N per service. |
| `dt_get_request_naming` | request-naming + request-attributes. |
| `dt_get_naming_rules` | Settings 2.0 conditional-naming rules. |
| `dt_get_conditional_naming` | Older v1 conditional-naming surface. |
| `dt_list_metrics` | `GET /api/v2/metrics` — paginated metric catalog with optional `metricSelector` (e.g. `builtin:service.*`) and text filter. Returns metricId, displayName, unit, dimensionDefinitions per entry. **Use before building a dashboard to confirm metric keys exist on this tenant.** |
| `dt_get_metric_metadata` | `GET /api/v2/metrics/{key}` — full metadata for ONE metric. Returns `{ exists: false }` on 404 instead of throwing, making it cheap as a pre-flight check. |
| `dt_get_dashboard_context` | **One-call preflight bundle** for dashboard creation. Returns: management zones (id+name), entity types, metrics catalog summary (counts by prefix) + a sample of metric ids. Each section degrades independently. Use this BEFORE constructing dashboard payload so you only reference real MZs / entity types / metrics. |
| `dt_search_logs` | `POST /api/v2/logs/search` — search ingested logs. The "is my log line landing with the right attributes?" tool. Returns matching records + the distinct attribute keys Dynatrace extracted. Read-only (uses read token). |
| `dt_query_metrics` | `GET /api/v2/metrics/query` — run a metric selector + timeframe + resolution. Returns raw Dynatrace response **and** a flattened compact form (one entry per series with first/last point, min/max/avg) for easy LLM analysis. |
| `dt_search_entities` | `GET /api/v2/entities` — find entities by selector (e.g. `type(SERVICE),tag(team:7orr)`). Auto-paginates up to 10 pages by default. |
| `dt_get_problem` | `GET /api/v2/problems/{id}` — full single-problem detail. Companion to `dt_get_problem_history` (which is the list/analysis view). |
| `dt_get_trace` | `POST /api/v2/spans/query` — look up spans by traceId (typical) or arbitrary spanSelector. Read-via-POST; token needs `traces.lookup`. Falls back gracefully with a note if endpoint isn't on this Managed version. |
| `dt_query_usql` | `GET /api/v1/userSessionQueryLanguage/table` — run USQL queries over RUM session data. Flattens the column-oriented response into row objects. Token needs `DTAQLAccess`. |

## Write tools (require `DT_WRITE_TOKEN`)

All writes are audited to JSONL files under `DT_AUDIT_DIR` (default
`<cwd>/.audit/<YYYY-MM-DD>.jsonl`). All mutating tools require an explicit
`confirm: "yes"` arg.

| Tool | Endpoint | Notes |
|---|---|---|
| `dt_validate_settings` | `POST /api/v2/settings/objects?validateOnly=true` | Dry-run a Settings 2.0 payload. No side effects. No confirm needed. Run BEFORE every create. |
| `dt_create_settings` | `POST /api/v2/settings/objects` | Create one or more Settings 2.0 objects. Requires `confirm: "yes"`. |
| `dt_update_settings` | `PUT /api/v2/settings/objects/{id}` | Replace an existing object. Supports `dryRun: true` (validateOnly). |
| `dt_delete_settings` | `DELETE /api/v2/settings/objects/{id}` | Delete an object. By default pre-fetches it, verifies `expectedSchemaId` matches, and writes the full prior value to the audit log so deletion is reversible. Pass `force: true` to skip the safety check. |
| `dt_ingest_metric` | `POST /api/v2/metrics/ingest` | Push custom metric data points in line protocol. Provide structured `points` or raw `linesText`. Max 1000 lines/request. To set unit/displayName, follow up with `dt_create_settings` against `builtin:metric.metadata`. |
| `dt_ingest_logs` | `POST /api/v2/logs/ingest` | Inject log records directly (up to 1000/call). Each record is `{ content, timestamp?, ...attrs }`. Pair with `dt_search_logs` to verify the DPP rules extracted the expected attributes. |
| `dt_ingest_bizevent` | `POST /api/v2/bizevents/ingest` | Push business events (default JSON or CloudEvents v1.0 encoding). Default encoding requires `event.type` + `event.provider`. |
| `dt_post_event` | `POST /api/v2/events/ingest` | Inject events (CUSTOM_INFO, ERROR_EVENT, etc.) into Dynatrace — the cleanest way to test alerting rules / MZ propagation / problem grouping without real traffic. |
| `dt_delete_dashboard` | `DELETE /api/config/v1/dashboards/{id}` | Delete a Config v1 dashboard. Same safety pattern as `dt_delete_settings` — pre-fetch + optional `expectedName` check + reversible audit. |
| `dt_raw_post` / `dt_raw_put` / `dt_raw_delete` / `dt_raw_patch` | any env-scoped path | Mutating escape hatches for endpoints with no typed wrapper. All require `confirm: "yes"`, use `DT_WRITE_TOKEN`, are audited. Prefer a typed tool when one exists. |
| `dt_close_problem` | `POST /api/v2/problems/{id}/close` | Close a problem with optional message. |
| `dt_comment_problem` | `POST /api/v2/problems/{id}/comments` | Add a comment (Dynatrace has no formal ack endpoint — use this for ack/triage notes). |
| `dt_create_token` | `POST /api/v2/apiTokens` | Create a new API token. **Token value is returned ONCE to the caller; the audit log redacts it** (never persists credential material to disk). |
| `dt_delete_token` | `DELETE /api/v2/apiTokens/{id}` | Delete a token. Same safety pattern as `dt_delete_settings` — pre-fetch + optional `expectedName` check. Metadata logged; value not (Dynatrace doesn't return it on GET). |
| `dt_add_tag` | `POST /api/v2/tags?entitySelector=...` | Apply CONTEXTLESS (manual) tags to entities matched by a selector. Use Settings 2.0 (`dt_create_settings` against `builtin:tags.auto-tagging`) for *rule-based* auto-tags. |
| `dt_remove_tag` | `DELETE /api/v2/tags?entitySelector=...` | Remove a manual tag. Either `value` (specific value) or `deleteAllWithKey: true` (every variant of the key). |
| `dt_create_slo` / `dt_update_slo` / `dt_delete_slo` | `/api/v2/slo[/{id}]` | Manage SLOs. Required: `name`, `target` (0–100), `timeframe`, and either `metricExpression` (modern) or `metricRate` (legacy). |
| `dt_create_synthetic_monitor` / `dt_update_synthetic_monitor` / `dt_delete_synthetic_monitor` | `/api/v1/synthetic/monitors[/{id}]` | Manage synthetic monitors (HTTP and BROWSER). `script` shape varies by type — see Dynatrace Synthetic docs. |

### Writing to auto-tag / naming / detection / alerting rules

These all live in Settings 2.0 — no dedicated wrappers because they're cleanly
covered by the generic settings tools:

```
dt_validate_settings → dt_create_settings → dt_update_settings → dt_delete_settings
```

Schema ids you'll typically use:
- `builtin:tags.auto-tagging` — auto-tag rules
- `builtin:management-zones` — MZs
- `builtin:process-group.advanced-detection-rule` — PG detection
- `builtin:service-detection.full-web-request` (and friends) — v1 service detection
- `builtin:service-detection-rules` (and friends) — v2 service detection
- `builtin:service.request-naming` — request naming
- `builtin:conditional-naming.processgroup` / `.host` / `.service` — display-name rules
- `builtin:alerting.profile` — alerting profile
- `builtin:logmonitoring.log-dpp-rules` — log processing
- `builtin:logmonitoring.log-events` — log-event rules

Always `dt_get_schema(schemaId)` first to see the exact field shape, then
`dt_validate_settings` before the create/update.
| `dt_create_dashboard` | `POST /api/config/v1/dashboards` | Create a Config v1 dashboard. Pass `dashboardMetadata` (name/owner/shared) + `tiles[]`. **Pre-validates every metric key referenced in the tiles against `/api/v2/metrics`** — refuses if any key is missing on this tenant. Pass `validateMetrics: false` to skip. |
| `dt_update_dashboard` | `PUT /api/config/v1/dashboards/{id}` | Full replacement. Same metric pre-validation as create. Body `id` must match `dashboardId`. |

### Why dashboard pre-validation matters

Dynatrace `POST /api/config/v1/dashboards` accepts dashboards referencing
metrics OR management zones that don't exist on the tenant. The dashboard is
created, the tile is created, and the failure only surfaces as an **empty
tile or a permission-locked filter in the UI**. This hides typos, metrics
that exist on SaaS but not Managed, custom metrics not yet ingested, and
stale MZ ids from copy-pasted payloads.

`dt_create_dashboard` and `dt_update_dashboard` walk the payload before
posting and check:

1. **Metric references** — `tile.queries[].metric`,
   `tile.queries[].metricSelector` (transforms stripped),
   `tile.filterConfig.chartConfig.series[].metric`, and
   `tile.customChartingItems[].metricExpression`. Each unique key is
   confirmed against `GET /api/v2/metrics/{key}`. On 404, the validator
   queries `<prefix>.*` to surface up to 5 likely intended siblings as
   `suggestions`.
2. **Management zone references** —
   `dashboardMetadata.dashboardFilter.managementZone.id` and per-tile
   `tileFilter.managementZone.id`. Looked up in the MZ list; missing ids
   surface in `missing`.

If anything is missing, the tool refuses the write and returns the full
validation result so the caller can fix it. Audit log records the refusal.

To intentionally bypass (e.g. the metric will be ingested seconds later via
`dt_ingest_metric`), pass `validateMetrics: false`.

### Recommended dashboard-building workflow

1. Call **`dt_get_dashboard_context`** first. You get a single bundle with
   every MZ id+name, entity types, metrics catalog summary, and metric id
   sample. Hand this to the LLM.
2. (Optional) **`dt_list_metrics`** to drill into a specific metric family
   you care about (e.g. `builtin:host.cpu.*`).
3. Build the dashboard JSON using only ids/keys that appeared in step 1/2.
4. **`dt_create_dashboard`** — the auto-validator runs again as a safety net
   and catches anything that slipped through.
5. If using a custom metric you'll ingest momentarily: `dt_ingest_metric`
   first with one data point so the catalog entry exists, then
   `dt_create_dashboard` (validation will now pass).

## Prompts

| Prompt | Purpose |
|---|---|
| `ahr` | Runs a phased Account Health Review. Discovers the de-facto tag taxonomy from live data. Stops after each phase for review. Args: `accountAlias` (required), `expectedKeys` (optional overlay). |

## Resources

| URI | Contents |
|---|---|
| `dt-spec://env-v2` | OpenAPI 3 spec for `/api/v2/*` (env-scoped). |
| `dt-spec://env-config-v1` | OpenAPI 3 spec for `/api/config/v1/*` (env-scoped). |
| `dt-spec://cluster-v1` | OpenAPI 3 spec for `/api/v1.0/onpremise/*` (cluster-scoped, needs cluster token). |

Specs are cached under `.cache/specs/<cluster-host>/` for 24h.

## Setup

```bash
npm install
npm run build
```

Configuration is env-driven — nothing is hardcoded.

| Variable | Required | Notes |
|---|---|---|
| `DT_CLUSTER_URL` | yes | e.g. `https://localhost:8080`. No trailing slash, no `/e/<env>`. |
| `DT_ENV_ID` | yes | Environment UUID. |
| `DT_TOKEN` **or** `DT_TOKEN_FILE` | exactly one | Read token. |
| `DT_CLUSTER_TOKEN` / `DT_CLUSTER_TOKEN_FILE` | optional | Cluster-scoped reads + `cluster-v1` spec. |
| `DT_WRITE_TOKEN` / `DT_WRITE_TOKEN_FILE` | optional | **When present, enables the write tools.** Use a separate, narrowly-scoped token (settings.write, metrics.ingest, WriteConfig) — not the same as your read token. |
| `DT_AUDIT_DIR` | optional | Directory for write-tool audit JSONL. Default: `<cwd>/.audit`. |
| `DT_TLS_VERIFY` | optional | Set to `0` to skip TLS verification (self-signed clusters). |

### Token scopes

**Read** (`DT_TOKEN`):
- `ReadConfig` — every Settings 2.0 read tool.
- `entities.read` — `dt_list_tags_for_entity`, entity-touching `dt_raw_get`.

**Write** (`DT_WRITE_TOKEN`) — grant only what you actually need:
- `settings.write` — `dt_create_settings`, `dt_update_settings`, `dt_validate_settings`.
- `metrics.ingest` — `dt_ingest_metric`.
- `WriteConfig` — `dt_create_dashboard`, `dt_update_dashboard`.

## Smoke test

```bash
DT_CLUSTER_URL=https://localhost:8080 \
DT_ENV_ID=<env-uuid> \
DT_TOKEN_FILE=~/.dt/localhost.token \
DT_TLS_VERIFY=0 \
npm run smoke
```

## Register with Claude Code

```bash
claude mcp add dt-managed \
  --scope user \
  --env DT_CLUSTER_URL=https://localhost:8080 \
  --env DT_ENV_ID=<env-uuid> \
  --env DT_TOKEN_FILE=$HOME/.dt/localhost.token \
  --env DT_WRITE_TOKEN_FILE=$HOME/.dt/localhost.write.token \
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
        "DT_TLS_VERIFY": "0"
      }
    }
  }
}
```

To run **read-only**, simply omit `DT_WRITE_TOKEN` / `DT_WRITE_TOKEN_FILE` — the
write tools won't register and any caller that tries to invoke them will get a
"tool not found" error.

## Relationship to the upstream MCP

`dynatrace-oss/dynatrace-managed-mcp` covers **observability data**: entities,
problems, events, SLOs, metrics, logs, security problems. It has zero
configuration-surface tools. This server is strictly complementary — register
both, and an Account Health Review agent can pull entity inventory from upstream
and configuration (auto-tags, management zones, detection rules) from here, then
apply remediations through the write tools without leaving the same session.
