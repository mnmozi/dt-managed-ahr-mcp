# AHR portable dashboard (Managed): status and next steps

Last updated: 2026-09-25

## Goal

A classic (Config v1) dashboard for Dynatrace Managed Account Health Reviews that:

- uses **tiles only** (no markdown with baked-in numbers), and
- is **portable**: the same JSON can be POSTed to any Managed environment and fills in with that environment's data.

It should answer these questions:

1. How many hosts are we monitoring?
2. Do the hosts have host groups?
3. How much log data are we ingesting?
4. Are we using events from logs and log metric extraction?

## What exists today

| Item | Where |
|---|---|
| Dashboard JSON (source of truth) | [`dashboards/ahr-portable.json`](../dashboards/ahr-portable.json) |
| Live copy in dev env | `https://<cluster-host>/e/<env-id>/#dashboard;id=<dashboard-id>` |

The dashboard has 11 tiles. It uses only `builtin:host.*`, `builtin:service.*`, and `builtin:billing.full_stack_monitoring.usage_per_host`, plus the Open Problems tile:

- Monitored hosts: a single value, a trend over time, and availability % per host. The count is `builtin:host.availability:splitBy():count`.
- Open problems
- Top hosts by CPU and by memory
- Services: median response time, failure rate, request count
- Full-stack host units per host
- Fullest disks

To deploy it to another environment, use `dt_create_dashboard` with the JSON file (set `owner` first), or:

```bash
curl -k -X POST "$DT_CLUSTER_URL/e/$DT_ENV_ID/api/config/v1/dashboards" \
  -H "Authorization: Api-Token $DT_WRITE_TOKEN" -H "Content-Type: application/json" \
  --data @dashboards/ahr-portable.json
```

## Question coverage

| Question | Can a portable tile answer it? | Reason |
|---|---|---|
| How many hosts | ✅ yes | `builtin:host.availability` count |
| Hosts per host group / ungrouped hosts | ❌ not natively | No built-in metric has a host-group dimension on Managed, and classic tiles can't list entities by property |
| Log volume | ❌ not natively | This cluster has no `builtin:logmonitoring.*` metrics, `builtin:billing.ddu.log` returns 404, and `/api/v2/logs/search` returns 405 (only GET is allowed) |
| Using log events / metric extraction | ❌ not natively | These are Settings 2.0 configuration counts, not time series. Classic dashboards have no tile type that shows them |

## Workaround (agreed direction, NOT built yet)

If a number doesn't exist as a metric, ingest it as a custom metric with a fixed key. A tile on that key then works in every environment.

1. **Collector script** (cron / Jenkins / ActiveGate host), pointed at an environment URL and token:
   - `GET /api/v2/entities?entitySelector=type(HOST)&fields=+properties.hostGroupName` groups the hosts by host group.
   - `GET /api/v2/settings/objects` counts the objects in `builtin:logmonitoring.log-events`, `builtin:logmonitoring.schemaless-log-metric`, and processing rules (`builtin:logmonitoring.log-dpp-rules`).
   - `POST /api/v2/metrics/ingest` sends lines such as:
     ```
     ahr.hostgroup.host_count,host_group="kargo-app" 1
     ahr.hosts.ungrouped_count 0
     ahr.config.log_event_rules 3
     ahr.config.log_metric_rules 21
     ahr.config.log_processing_rules 42
     ```
   - Token scopes needed: `entities.read`, `settings.read`, `metrics.ingest`. The dev `admin-token` has all three.
2. **Catch-all log metric-extraction rule**: one `builtin:logmonitoring.schemaless-log-metric` object that matches all logs, measures occurrence, and produces `log.ingest.total.count`. It is created through the Settings API, so the same rule can be pushed to every environment.
3. **Add tiles** for `ahr.hostgroup.host_count:splitBy(host_group)`, `ahr.hosts.ungrouped_count`, `ahr.config.*` (single values), and `log.ingest.total.count`. Then update `dashboards/ahr-portable.json`.

After this, adding an environment means: run the collector against it, push the log rule, and push the dashboard JSON. The JSON itself stays the same.

Suggested next session: build the collector (TypeScript in `scripts/` to match the repo, or a new MCP tool such as `dt_ahr_ingest_snapshot`), create the catch-all rule in the dev environment, run the collector once, and add the four tile groups.

## Audit snapshot from dev env <env-id> (2026-07-30)

Use these numbers to check that the collector's metrics come out right.

- **Hosts:** 10 in total, all Linux and all FULL_STACK. All at 100% availability.
- **Host groups:** 7 groups and 0 ungrouped hosts. Five groups have one VM each: `kargo-app`, `kargo-customs`, `kargo-svc`, `kargo-tariff`, `kargo-web`. `dev` has 4 hosts and is flagged as a generic name. `hang-demo-managed` has 1.
- **Log pipeline:** 13 storage rules, 42 processing rules (4 of them custom), 2 bucket rules, 1 timestamp config. Logs on Grail is not active. Agent flags: container and journald detectors are on.
- **Events from logs:** 3 rules, all enabled:
  - "7orr payment processed" (INFO)
  - "7orr checkout failure" (ERROR, Davis-merged)
  - "Payment Initiate Request Detected" (annotation)
- **Log metric extraction:** 21 rules, which produce 22 `log.*` metrics. They cover cart/checkout, logins, notifications, SSR, postgres, and error/exception counts.
- **Consumption:** of the `builtin:billing.*` metrics checked, only `full_stack_monitoring.usage_per_host` (about 3,230 over 7 days) and `synthetic.actions` (0) exist. `hostunits`, `ddu.*`, and `usersession.*` return 404.
- **Other gaps:** `/api/v2/oneagents` returns 404 on this cluster, so `dt_get_oneagent_versions` fails.
