# Known gaps & limitations

Living list. Add entries when live usage exposes a hole; move to "resolved"
with the commit/date when closed.

## Open

### Naming pipeline
- **No systemd-unit name source.** The one signal that would have named
  `tracking-service` directly (unit `shop-tracking`) isn't surfaced by
  OneAgent as an entity property we've found. Check PGI properties for unit
  metadata; else document as blind spot.
- **Short-lived processes are invisible.** Batch/timer workloads (e.g. a
  5-min report worker) land in the "Short-lived processes" bucket PG and
  can never be named. Remediation is detection-level: PG detection rule or
  DT_TAGS in the unit, not naming.
- **Advisory noise patterns.** Symmetric back-suggestions (A→B while B→A)
  and superstring candidates (current name + tech prefix). Two candidate-
  filter rules would clean both.
- **`populatedThreshold = 5` hardcoded** in hostgroups typo detection —
  inert on small clusters; not echoed in appliedDefaults.
- **Pattern tables lag new tech** by design; auditAll mode is the
  mitigation (coverage without flagging precision).

- **Anomaly-detection schemas dropped without replacement on 1.346**
  (`infrastructure-disks.classic`, `infrastructure-network`) — old probe ids
  kept for multi-version tolerance, but on 1.346 those signals simply have
  no Settings surface anymore.
- **P2 backlog from the 1.346 coverage sweep**: 53 live schemas remain
  without a dedicated wrapper (2026-08-20, after the tier-1/tier-2 pass) —
  deliberately: synthetic per-monitor sub-configs (the synthetics API
  already returns them), mainframe/IBM MQ (no such workload), dashboard/
  user preferences, metric cosmetics, generic-entity topology extensions,
  attribute capture/masking, settings-based SLOs, token-security settings.
  The last three are the next candidates if the AHR grows a privacy or
  token-hygiene phase. Raw access via dt_list_settings_objects; the drift
  script prints the current uncovered list on every run.

### From the design review (2026-07-06, three-agent audit)
- P0: map-iteration nondeterminism in fleet/hostgroups winners; tech.only
  fallback dead post-refactor; `candidates: null` vs zod array in apply
  tools; lattice ignores flagging state under auditAll.
- P1: fleet-boost agreement never verified; hosts/services pre-trim breaks
  explain completeness; scripts/ not typechecked; logger dead-stream
  routing + field clobber.
- P2: lattice validates caller-supplied reports (needs server-side report
  cache for real enforcement); 3× tool copy-paste; GUI escape hardening;
  silent pagination truncation; relationship self-loops.

## Resolved

- **Settings validation lost per-item errors on a 4xx** (2026-10-06, live
  1.350.7). validateOnly answers 200 (all valid), 207 (mixed) or the
  items' own 4xx when EVERY item fails — with the per-item array still in
  the body. The pre-check treated any 4xx as a batch failure (`<batch>`,
  body cut at 500 chars), so the common single-object create lost its
  constraint violations; dt_validate_settings returned `validated: true`
  for a 207 mixed batch. Both now share `validateSettingsBatch` (parses
  the array from 2xx and 4xx bodies; only a non-array body is a batch
  error) and report `invalidItems[]` by index with a `hint` for the opaque
  messages (SaaS-only schema, non-DPS license, unadvertised id, scope
  class not allowed, unknown property). Name-collision map gained
  `builtin:event-correlation-rules` (displayName). Not changed:
  dt_update_settings still PUTs without a pre-check (dryRun is opt-in)
  and returns raw errors.

- **Cluster upgrade 1.346.69 → 1.350.7** (2026-10-06). Schema inventory
  227 → 233: 6 added, 0 removed, 29 version bumps (all patch/minor; none
  touch a hardcoded write payload — writes go through dt_create_settings /
  dt_validate_settings). No wrapper went dark. New schemas wired in:
  `event-correlation-rules` + `platform-event-correlation` →
  dt_get_alerting_profiles; `metric.limits-alerts` +
  `billing.container-application-monitoring.optin` → dt_get_cost_controls;
  `logmonitoring.log-agent-cpu-quota` → dt_get_log_ingestion_rules.
  `synthetic.monaco-external-id` left to the P2 backlog. Baseline refreshed.
  **Behavioural change found live:** `/api/v1/oneagents?includeDetails=true`
  now returns modules (empty on 1.346), but as `{moduleType, instances[{
  active, moduleVersion, faultyVersion}]}` with no `enabled` field. Read
  naively, every module looked disabled: dt_get_oneagent_module_status
  would have flagged every detected tech as a gap, and the engine's
  CHECK_FULLSTACK_NO_LOGS every FULL_STACK host (4/4 live, all of which
  have an active LOG_ANALYTICS). Fixed in both: modules are normalized
  (enabled = any instance active, version = first instance; explicit
  `enabled` wins), engine HostInfo falls back to displayName for v1. The
  tech-gap heuristic also stopped counting platforms (Kubernetes,
  OpenShift, Docker, containerd, CRI-O, …) as unmonitored technologies —
  all 4 live "gaps" were KUBERNETES. Tests in both repos.

- **Cluster-level surface had no typed tools** (2026-09-09). The MCP had
  the plumbing (DT_CLUSTER_TOKEN_FILE, scope:"cluster" in the client,
  dt_raw_get scope='cluster', cluster spec resource, cluster deny-list for
  writes) but nothing an AHR could call, and the prompt had no Phase 6.
  Paths were taken from the cluster's own OpenAPI specs
  (`/api/v1.0/onpremise/spec3.json`, `/api/cluster/v2/spec3.json`) — the
  collector's old Phase 6 guessed `/version`, `/environments`,
  `/cluster/configuration/nodes`, none of which exist. Added, read-only,
  redacted (password/secret/bind fields), available:false-with-hint when
  no cluster token: `dt_cluster_get_overview` (nodes, versions,
  maintenance, upgrade, Elasticsearch, environments),
  `dt_cluster_get_activegates` (cluster-wide fleet + auto-update + token
  enforcement), `dt_cluster_get_access_governance` (users, groups, MZ
  permissions, auth mode, LDAP, password policy, SAML cert),
  `dt_cluster_get_platform_settings` (preferences, SMTP, proxy, backup,
  endpoints, network zones, synthetic), `dt_cluster_get_license`,
  `dt_cluster_get_tokens`, `dt_cluster_get_settings` (cluster-scope
  Settings 2.0 sweep). AHR prompt gained Phase 6 with the flags per tool.
  Collector Phase 6 rewritten to the same paths with redaction. First
  live read already surfaced: backups disabled, SMTP NO_ENCRYPTION,
  several unnamed cluster tokens, single-node cluster.

- **Two more "surface moved" classes found via the offline collector audit
  (2026-09-09)**, fixed in MCP, collector and engine:
  - **`/api/v2/oneagents` does not exist on Managed 1.346** (404); the
    surface is `/api/v1/oneagents`. Both `dt_get_oneagent_versions` and
    `dt_get_oneagent_module_status` were failing. New shared helper
    `helpers/oneagents.ts` (v2 → v1 fallback, v1 hosts normalized to the v2
    shape: hostName from displayName, version from the agentVersion object,
    detectedTechnologies from softwareTechnologies; 5 tests). BUT: v1 on
    this cluster returns `modules: []` and no version for every host even
    with includeDetails=true — "module data unavailable", which the module
    tool previously would have read as "every FULL_STACK host has logs off"
    (17 false positives). The tool now reports `moduleDataAvailable:false`
    + warning and skips the per-host verdicts; the engine's
    CHECK_FULLSTACK_NO_LOGS emits one Info finding instead. Alternative
    source for later: HOST entity properties `installerVersion`,
    `monitoringMode`, `logFileStatus`, `logSourceState`.
  - **Billing metric keys moved** exactly like schemas: `builtin:billing.
    hostunits`, `ddu.metrics`, `ddu.log`, … no longer exist (7 of the 9
    curated keys); the cluster advertises `builtin:billing.ddu.*.total`,
    `full_stack_monitoring.usage_per_host`, `real_user_monitoring.*.usage`
    etc. `dt_get_consumption_summary` now discovers `builtin:billing.*`
    live and queries the aggregate series (46 on this cluster), grouped by
    family; breakdown series are counted, not queried
    (`helpers/billing-metrics.ts`, tests).
  - **Engine used the wall clock** in CHECK_TOKEN_NEVER_USED (its own
    doctrine forbids it); the golden fixture had silently changed answer
    with the calendar. Bundles now carry a reference time from
    `manifest.json` `generatedAt` (`Bundle.Now()`), fixture pinned.
  - Collector (`dt-managed-ahr-collector`) rewritten around the same
    principles: inventory-driven Settings sweep (no schema lists), metric
    discovery, Config v1 companions, pagination everywhere, retries,
    error files never named like data, manifest.json. Live: 101 errors →
    0. See its README.

- **Post-patch verification through the running MCP (1.346.69, 2026-09-09)**
  surfaced two defects, both fixed:
  - **Phantom schemas.** `GET /settings/objects?schemaIds=X` answers 200
    for some ids the cluster does NOT advertise (live:
    `builtin:bizevents.http.incoming` — objects 200, schema detail 404,
    absent from the inventory). The wrapper counted that as "alive" and
    reported `ok`, disagreeing with the drift script. Now "alive" means
    ADVERTISED: the wrapper fetches the schema inventory (cached 5 min per
    process), marks such probes `phantom: true` and excludes them from
    surfaceStatus; if the inventory can't be fetched it falls back to the
    old behaviour. Drift script prints phantoms so nobody "fixes" a probe
    that is behaving correctly. 2 tests.
  - **`dt_get_recently_changed_settings` overflowed the MCP result** after
    the full-scan rewrite (30 days → 266 changed objects → 117k chars).
    Per-schema item lists are now capped (`maxItemsPerSchema`, default 10,
    newest first) with an exact `omitted` count; totals stay exact.
  Also clarified in `dt_get_host_monitoring_modes`: zero objects for a
  host.monitoring* schema = no overrides, defaults apply (not "unknown").

- **Schema check after cluster patch 1.346.26 → 1.346.69** (2026-09-09).
  Inventory unchanged (227 ids, no added/removed, no wrapper went dark,
  all Config v1 companions alive). Exactly one version bump:
  `builtin:failure-detection.environment.rules` 1.0.11 → 1.0.12 — read-only
  for us (probe in dt_get_failure_detection, no hardcoded fields, no
  dedicated write tool), so no code change. New mechanism: the repo now
  carries `schema-baseline.json` (schemaId → latestSchemaVersion, stamped
  with cluster version + date) and `npm run drift:schemas` diffs ids AND
  versions against it on every run — version bumps are what silently
  change write-payload shapes, which id-only checks can't see. After
  reviewing a diff, `npm run drift:schemas -- --update-baseline` rewrites
  it from the live cluster.

- **Six read wrappers were fully dead on Managed 1.346 and returned empty
  success — "lying tools"** (2026-08-20, fix brief vs live 1.346.26).
  Root causes: schema renames (`builtin:network-zones` → `builtin:networkzones`,
  `builtin:eec-local/-remote` → `builtin:eec.local/.remote`,
  `process-monitoring.*` → `process.*` / `processavailability`,
  AD `databaseservices`/`applications`/`applications-mobile` →
  `databases`/`rum-web`/`rum-mobile`) and surfaces that never lived in
  Settings 2.0 on Managed at all (request naming, conditional naming,
  custom services = Config v1; releases = v2 API; bizevents = SaaS/Grail-only).
  Fixes, per the prime directive (add ids, never delete):
  - schema-wrapper now emits `surfaceStatus: ok | config-v1-only |
    SURFACE_MISSING` — a fully-dead probe list returns `isError: true` with
    an explicit "tool blind spot, not empty config" warning (5 tests).
  - `companionEndpoints` support: wrappers can carry Config v1 / v2 paths
    (requestNaming, requestAttributes, conditionalNaming×3, networkZones,
    releases, customServices×5 with 404 → unsupported-on-this-version).
  - `dt_get_business_events` carries a staticNote: bizevents schemas are
    SaaS/Grail-only, SURFACE_MISSING on Managed is EXPECTED.
  - New wrappers: `dt_get_update_governance` (builtin:deployment.*) and
    `dt_get_cost_controls` (accounting.ddu.limit, metric.dimensionblocklist).
  - `dt_get_recently_changed_settings` now scans EVERY schema (live
    inventory, batched) instead of a curated 20-list with 6 dead ids.
  - `scripts/check-schema-drift.ts` (`npm run drift:schemas`) diffs every
    probe list + companion endpoint against the live cluster; exit 1 on any
    fully-dead wrapper. Run after every Managed upgrade.
  - ahr.ts (3 sites) + service-request-cardinality advice no longer point
    agents at nonexistent Settings 2.0 naming schemas.

- **`dt_get_pg_detection_rules` probed a removed schema** (found 2026-07-16
  on 1.342, fixed 2026-08-20): added `builtin:process-grouping-rules` and
  `builtin:process-group.cloud-application-workload-detection` to the probe
  list (old ids kept).

- **Method-2 conditional-naming template had wrong nesting** (2026-07-07,
  found by schema-drift check against live cluster 1.342). Our generated
  body wrapped conditions in an inner `{type, conditions[]}` object; the
  real Config v1 shape is a FLAT `rules[]` of `{key, comparisonInfo}` with
  `key.type: "STATIC"`. Fixed in apply-naming-decisions.ts, the GUI
  Method-2 generator, and a test asserting the flat shape. Caught BEFORE
  any createNamingRule call was made — the flag would have 400'd.

- **`dt_apply_pg_naming_rule` naming honesty** (2026-07-06). The tool wrote
  only `name:<value>` tags while its name implied real naming rules; the
  operator had to hand-create 14 conditional-naming rules via the config
  API. Resolved by extending all three apply tools with
  `createNamingRule: true` — creates Config v1 conditional-naming rules
  keyed on the tag (one per distinct name), deduped against existing rules
  by nameFormat, audited. Tool descriptions now state plainly that tags
  alone do NOT change display names. Rule schema validated live on
  Managed 1.341 (the operator's 14 hand-created rules used this shape).
- **Missed heuristics from first live audit** (2026-07-06): gunicorn/uvicorn
  et al. added to bare-tech table; `<tech> on <bind-address>`, technology-
  shell (`Catalina/localhost (/ctx)`), tech-prefixed composite, generic
  role-words (`server`, `worker`); health-probe endpoint noise; metadata[]
  property array support; SERVICE_METHOD two-hop endpoint join.
