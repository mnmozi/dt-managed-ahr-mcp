# Known gaps & limitations

Living list. Add entries when live usage exposes a hole; move to "resolved"
with the commit/date when closed.

## Open

### Naming pipeline
- **No systemd-unit name source.** The one signal that would have named
  `tracking-service` directly (unit `kargo-tracking`) isn't surfaced by
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
