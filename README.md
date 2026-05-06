# dt-managed-ahr-mcp

MCP server that wraps the Dynatrace Managed **Settings 2.0** and **config** APIs
that the upstream [`dynatrace-managed-mcp`](https://github.com/dynatrace-oss/dynatrace-managed-mcp)
does not expose — specifically the surface needed to run an Account Health Review:
auto-tagging rules, management zones, process-group and service detection rules,
request naming, and per-entity tag context.

Use this server alongside the upstream one. There is no overlap in tools.

## Tools

| Tool | Purpose |
|---|---|
| `dt_whoami` | Cluster URL + env id + TLS verify + token introspection (name, scopes, expiration). Run first in any AHR. |
| `dt_get_oneagent_versions` | OneAgent rollout summary (versions, autoUpdate, monitoring mode, faulty count, hosts behind latest). |
| `dt_get_oneagent_module_status` | Per-host module on/off + detected-tech-not-monitored gap. Flags FULL_STACK hosts with logs disabled, hosts with detected tech that has no enabled module, misconfigured modules. |
| `dt_get_oneagent_features_and_enrichment` | Settings 2.0 schemas for OneAgent feature flags + metadata/context enrichment + log-agent feature flags. Tolerant probe across DT versions. |
| `dt_get_activegate_versions` | ActiveGate summary (versions, type, autoUpdate, connection status, misconfigured modules). |
| `dt_get_maintenance_windows` | Pulls MWs from both Settings 2.0 and Config v1 surfaces. |
| `dt_get_consumption_summary` | Curated billing/DDU metrics over a window — host units, DDU by category, synthetic, sessions. |
| `dt_list_schemas` | List all Settings 2.0 schemas available on the environment. |
| `dt_get_schema` | Fetch a single schema's field structure, types, enums, defaults. Use `mode='summary'` (default) for an LLM-friendly flat field list, or `mode='full'` for the raw schema. Use this to know what fields you can set when constructing a payload for `dt_create_settings`. |
| `dt_list_settings_objects` | Paginate Settings 2.0 objects for one or more `schemaIds`. |
| `dt_get_settings_object` | Fetch one object by `objectId`. |
| `dt_raw_get` | Escape hatch — GET any API path (env-scoped by default, `scope:'cluster'` for cluster paths). |
| `dt_list_tags_for_entity` | `/api/v2/tags` with an `entitySelector`; returns each tag's `context` (manual vs auto vs infrastructure). |
| `dt_get_process_properties` | Categorizes a PROCESS_GROUP / PROCESS_GROUP_INSTANCE / HOST entity into env vars, JVM args, exe info, listening ports, k8s/AWS metadata. Includes a `rulableProperties` list with stability ratings — call this BEFORE proposing an auto-tag or PG-detection rule so you choose a stable signal. |
| `dt_get_auto_tags` | All `builtin:tags.auto-tagging` objects. |
| `dt_get_management_zones` | All `builtin:management-zones` objects. |
| `dt_get_pg_detection_rules` | `builtin:process-group.advanced-detection-rule` + `builtin:process-group.detection-flags`. |
| `dt_get_service_detection_rules` | All four v1 `builtin:service-detection.*` schemas (OneAgent-detected services). |
| `dt_get_v2_service_detection` | v2 surface for k8s + OTel: service-detection-rules, service-splitting-rules, endpoint-detection-rules, url-path-pattern-matching-rules, unified-services-endpoint-metrics, apis.detection-rules. |
| `dt_get_failure_detection` | Failure detection rulesets + env rules + per-protocol params. |
| `dt_get_trace_sampling_and_ingest` | url-based sampling, rpc-based sampling, trace ingest control (env + global), muted requests. |
| `dt_get_service_anomaly_detection` | `builtin:anomaly-detection.services` — global + per-service overrides. |
| `dt_get_anomaly_detection` | Full AD surface beyond services: metric events, infrastructure (hosts/disks/network/vmware), applications (RUM + mobile), database services, kubernetes (cluster/namespace/workload), frequent-issue toggle. |
| `dt_get_process_monitoring_rules` | Process-monitoring scope schemas — drives DDU + host-unit cost. Pair with Phase 5 findings. |
| `dt_get_log_ingestion_rules` | Log ingestion / processing / storage / metric-extraction / masking. DDU-logs driver. |
| `dt_get_network_zones` | `builtin:network-zones` — OneAgent → ActiveGate routing. |
| `dt_get_ownership_teams` | `builtin:ownership.teams` directory of teams. |
| `dt_get_alerting_profiles` | `builtin:alerting.profile` — who gets paged for what. |
| `dt_get_problem_notifications` | Slack/Teams/email/webhook + AppSec notification schemas. |
| `dt_get_audit_log_settings` | `builtin:audit-log` config (different from entries). |
| `dt_get_audit_log_entries` | `/api/v2/auditlogs` recent activity + summary by category/user/eventType. |
| `dt_get_extensions` | Installed Extensions 2.0 + version sprawl detection. |
| `dt_get_synthetic_monitors` | `/api/v2/synthetic/monitors` summary. |
| `dt_get_dashboards_inventory` | `/api/config/v1/dashboards` listing + owner stats. |
| `dt_get_cloud_integration` | AWS / Azure / GCP / K8s / CloudFoundry / VMware schemas. |
| `dt_get_appsec_config` | Vulnerability + RAP + code-level + alerting + notification AppSec schemas. |
| `dt_get_rum_config` | Comprehensive RUM Settings 2.0 sweep: detection, injection, beacon, naming, KUAs, session props, conversion goals, errors, exclusions, resources, apdex/KPM, enablement, session replay, privacy, mobile + custom apps. |
| `dt_get_rum_app_inventory` | Discovers APPLICATION / MOBILE_APPLICATION / CUSTOM_APPLICATION entities with per-app session count. |
| `dt_get_rum_app_feature_matrix` | Per-app audit across ~25 RUM features — Session Replay, KUAs, naming, apdex, exclusions, privacy, AD overrides etc. Reports configured-explicit / configured-via-default / missing per feature with recommendations. |
| `dt_get_business_events` | BizEvents incoming + processing pipelines. |
| `dt_get_custom_services_and_key_requests` | Custom service definitions + key-request subscriptions. |
| `dt_get_opentelemetry_config` | OTel ingestion settings + span schemas. |
| `dt_get_release_monitoring` | Release/deployment events config. |
| `dt_get_log_monitoring_extras` | Log monitoring meta surfaces beyond ingestion (feature flags, Grail activation). |
| `dt_get_api_tokens` | `/api/v2/apiTokens` inventory + security findings (no expiration / expired / never-used / stale / high-priv / scope distribution). |
| `dt_get_oauth_clients` | `/api/v2/oauthClients` inventory; tolerant if endpoint not on this version. |
| `dt_get_span_capturing` | Span capturing + attribute extraction schemas — DDU-traces driver. |
| `dt_get_problem_history` | 30d problem analysis: MTTR (mean/p50/p95), top recurring root entities, stuck-open problems. |
| `dt_get_orphan_settings_scopes` | Settings 2.0 objects scoped to entity ids that no longer exist. |
| `dt_get_entity_orphans` | SERVICE-without-PG, HOST-without-monitored-PG, zombie-PG, inactive-host. |
| `dt_get_recently_changed_settings` | Settings 2.0 objects modified in last N days, grouped by schema. Config churn lens. |
| `dt_get_calculated_service_metrics` | Settings 2.0 (multiple candidate schemas) + Config v1 calculated service metrics. |
| `dt_get_service_request_cardinality` | Distinct request-name count per service over a window + top-N; flags high-cardinality services that need a request-naming rule. |
| `dt_get_request_naming` | `builtin:service.request-naming` + `builtin:service.request-attributes`. |
| `dt_get_naming_rules` | Settings 2.0 conditional-naming rules for PGs / hosts / services. Tolerates schemas not present on this Managed version. |
| `dt_get_conditional_naming` | Older `/api/config/v1/conditionalNaming/{processGroup\|host\|service}` surface. `includeDetails` fetches each rule's full body. |

## Prompts

| Prompt | Purpose |
|---|---|
| `ahr` | Runs a phased Account Health Review. Discovers the de-facto tag taxonomy from live data — does **not** require a pre-declared taxonomy. Stops after each phase for review. Args: `accountAlias` (required), `expectedKeys` (optional overlay). |

In Claude Code, invoke it as `/ahr` once the MCP is connected (the exact slash-command name depends on how Code namespaces MCP prompts; check `/mcp` output).

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
| `DT_ENV_ID` | yes | Environment UUID (the ID in `/e/<uuid>/` URLs). |
| `DT_TOKEN` **or** `DT_TOKEN_FILE` | exactly one | Token value directly, or absolute path to a single-line gitignored file. |
| `DT_CLUSTER_TOKEN` / `DT_CLUSTER_TOKEN_FILE` | optional | Same rule; only needed for `/api/cluster/*` calls and the `cluster-v1` spec resource. |
| `DT_TLS_VERIFY` | optional | Set to `0` to skip TLS verification (self-signed localhost clusters). |

### Token scopes

Minimum scopes for the environment token:

- `ReadConfig` — required by every Settings 2.0 tool.
- `entities.read` — required by `dt_list_tags_for_entity` and any entity-touching `dt_raw_get`.

## Smoke test

Proves the token + URL + TLS settings are correct by calling
`/api/v2/settings/schemas` and confirming the AHR-critical schemas are present.

```bash
DT_CLUSTER_URL=https://localhost:8080 \
DT_ENV_ID=<env-uuid> \
DT_TOKEN_FILE=~/.dt/localhost.token \
DT_TLS_VERIFY=0 \
npm run smoke
```

## Register with Claude Code

```bash
claude mcp add dt-ahr \
  --scope user \
  --env DT_CLUSTER_URL=https://localhost:8080 \
  --env DT_ENV_ID=<env-uuid> \
  --env DT_TOKEN_FILE=$HOME/.dt/localhost.token \
  --env DT_TLS_VERIFY=0 \
  -- node /absolute/path/to/dt-managed-ahr-mcp/dist/server.js
```

Or directly in `~/.claude.json` / project `.mcp.json`:

```json
{
  "mcpServers": {
    "dt-ahr": {
      "command": "node",
      "args": ["/absolute/path/to/dt-managed-ahr-mcp/dist/server.js"],
      "env": {
        "DT_CLUSTER_URL": "https://localhost:8080",
        "DT_ENV_ID": "<env-uuid>",
        "DT_TOKEN_FILE": "/Users/you/.dt/localhost.token",
        "DT_TLS_VERIFY": "0"
      }
    }
  }
}
```

## Relationship to the upstream MCP

`dynatrace-oss/dynatrace-managed-mcp` covers **observability data**: entities,
problems, events, SLOs, metrics, logs, security problems. It has zero
configuration-surface tools. This server is strictly complementary — register
both, and an Account Health Review agent can pull entity inventory from upstream
and configuration (auto-tags, management zones, detection rules) from here.
