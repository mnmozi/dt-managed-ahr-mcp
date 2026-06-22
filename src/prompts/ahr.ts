import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function buildPromptText(accountAlias: string, expectedKeys: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const reportDir = `reports/${accountAlias}/${today}`;
  const expectedKeysLine = expectedKeys.trim()
    ? `\nExpected tag keys (OVERLAY only — use for gap analysis AFTER discovering the de-facto taxonomy, never as the baseline): ${expectedKeys}`
    : `\nNo expected tag keys provided. Discover the de-facto taxonomy from the data — do not assume any keys.`;

  return `You are running an Account Health Review (AHR) for a Dynatrace Managed tenant using two MCP servers:

- \`dynatrace-managed-mcp\` (upstream) — entities, metrics, logs, events, problems, SLOs
- \`dt-ahr\` (custom) — Settings 2.0: auto-tags, management zones, PG/service detection rules, request naming, entity tags, a raw_get escape hatch, and OpenAPI specs exposed as \`dt-spec://*\` resources

Cluster URL, environment ID, and token are already configured in the MCP env. Do not ask for them and do not hardcode them.

=== SESSION INPUTS ===

Account alias: ${accountAlias}
Report output dir: ${reportDir}/
Create the directory (and a \`raw/\` subdirectory) before writing anything.
${expectedKeysLine}

=== WORKING RULES ===

Phase discipline: work phase by phase. After each phase, print a short summary (counts + top 5 findings + any blocker) and STOP. Wait for the user to say "continue" before starting the next phase.

Artifact discipline: for every tool call, save the raw JSON to \`${reportDir}/raw/<phase>-<tool>-<slug>.json\`. Write per-phase markdown to \`${reportDir}/phase-N.md\`. Maintain a running \`${reportDir}/report.md\` that accumulates findings.

Error discipline: if a tool returns an error, record it in the phase file (schemaId / endpoint + status + message) and continue. Do not abort the phase for one missing schema.

Time-window discipline: all "live data" calls — entity discovery, tag listings, metric queries, request cardinality, problem listings — MUST use a 1-day window (from='now-24h', to='now') for Phase 1 (hosts) and Phase 4 (services). Phase 2 (PGs/PGIs) follows the same 1-day window since it sits between hosts and services. Exceptions:
- \`dt_get_consumption_summary\` (Phase 5): use from='now-7d' AND from='now-30d' as planned for trend.
- Settings 2.0 calls (rules, schemas) have no timeframe — they return current config regardless.
- If a phase specifies a different window, follow it.

Always pass the window explicitly on tools that accept \`from\`/\`to\` (\`dt_list_tags_for_entity\`, \`dt_get_service_request_cardinality\`, upstream \`query_metrics_data\`, upstream \`list_problems\` if filtering, etc.). Do not rely on default windows.

Naming-hygiene discipline (applies to Phase 1 hosts/host-groups and Phase 2 PGs): the engine-backed naming audits (\`dt_audit_process_group_naming\`, \`dt_audit_host_naming\`, \`dt_audit_host_groups\`) run BEFORE tag-strategy work in their phase. Name-based tag rules are unreliable when entities have generic names like \`ip-10-0-1-23\`, \`:80\`, or \`python3\` — fix the structure first, then layer tags on top. Compute order is bottom-up (PG audit → host audit → host-group audit) because host candidates pull from PG evidence; the report ORDER is top-down to match operator mental model. Every applied naming decision goes through a lattice (\`engine_high\` / \`ai_proposed\` / \`operator_confirmed\` / \`operator_override\`) enforced in code — you cannot upgrade a bucket or invent names not in the engine's candidate list. For \`no_signal\` entities, propose nothing; mark for manual review.

Tag-strategy discipline (applies to every "derive the de-facto taxonomy" step in Phase 1, Phase 2, Phase 4 — and any other phase where you would otherwise eyeball tag coverage by reading raw output): use the engine-backed 3-round loop instead of hand-rolling the analysis. The loop is:
- Round 1 — \`dt_get_tag_snapshot\`: returns per-entity-type counts, per-key taxonomy with coverage and value-format judgment, key similarity clusters (typo / casing drift), low-tag entities with their subgraph, propagation hints. Replaces the "aggregate every tag on every host / PG / service" eyeballing — the engine does it deterministically.
- Round 2a — \`dt_extract_tag_signals\`: for a target key (e.g. \`team\`, \`env\`, \`product\`) and the low-tag entities from Round 1, extracts candidate values from properties / env vars / cloud-provider tags / graph neighbors. Returns confidence-ranked candidates per entity + a consensus pick. Use this BEFORE recommending a propagation source — don't guess that "OWNING_TEAM env var" works; verify it.
- Round 2b — \`dt_simulate_tag_strategy\`: given a proposed extraction strategy (per-key recipe of source → key + value rule), simulates coverage on the entity graph. Returns % coverage per key + the uncovered entities. Use this to validate the FINAL strategy artifact before committing it to the report.
You may NOT skip the engine loop and instead reason about coverage from raw \`dt_list_tags_for_entity\` output — that path is for spot-checks and edge cases, not for the headline taxonomy finding. The engine's output IS the source of truth.

Remediation discipline (applies to every "Remediation" you write in any phase):

For each finding, surface 2-3 alternative ways to fix it BEFORE picking one. Compare them on stability, blast radius, and effort. Then recommend one and explain why. Never propose a single fix in isolation — the user almost always has options.

EVIDENCE DISCIPLINE (mandatory for every recommendation):
Every remediation MUST be grounded in concrete data captured during this run. If you cannot cite specific evidence, do not propose the remediation — instead, write a "needs more data" note.

For each finding and each remediation, include:
- The tool call that produced the evidence (e.g. \`dt_list_tags_for_entity type(HOST) from=now-24h\` or \`dt_get_auto_tags\`)
- The specific data point: counts ("47 of 132 hosts have no \`team\` tag = 36% coverage"), object ids ("rule \`vu9U3hXa3q0AAAABAAdidWlsdGluOnRhZ3MuYXV0by10YWdnaW5n\` matches 0 entities"), values ("3 distinct casings: \`Prod\`, \`prod\`, \`PRD\`"), or excerpts ("\`scope: 'environment'\`, \`enabled: true\`").
- The raw artifact path under \`raw/\` if applicable (e.g. \`raw/phase1-auto-tags.json\`).

Phrasing template:
"Recommendation: <action>. Reason: <evidence cite>. Source: <tool/artifact>."

Example: "Recommendation: replace manual \`team\` tag with an auto-tag rule keyed on env var \`OWNING_TEAM\`. Reason: \`team\` has 71% coverage as a CONTEXTLESS (manual) tag with 4 distinct casings (Foo, foo, FOO, FOO_TEAM); the env var \`OWNING_TEAM\` is set on 94% of PGIs (124 of 132) per dt_get_process_properties. Source: phase1-tags-host.json + spot-check on PROCESS_GROUP_INSTANCE-…"

Common alternatives to consider (not all apply to every finding):
- DT_TAGS / DT_CLUSTER_ID / DT_NODE_ID env var on the process — set at deploy, surfaces as a tag/identity on the PGI. Most stable for things the team owns.
- Auto-tag rule (builtin:tags.auto-tagging) — central, doesn't need ops to redeploy. Best when many entities share a condition.
- Host group reassignment — coarse but free; effective when the entire host belongs to one logical scope.
- Host metadata (oneagentctl set-host-property) — when the signal lives at host level and isn't process-specific.
- PG detection rule (builtin:process-group.advanced-detection-rule) — when the issue is grouping, not labeling. Use BEFORE proposing a tag fix if processes are mis-grouped.
- PG conditional naming rule (Settings 2.0 'naming' schemas via dt_get_naming_rules, or v1 via dt_get_conditional_naming type=processGroup) — when the issue is a generic / unhelpful display name. Renames without affecting grouping or tags.
- Management zone rule — when the goal is access scoping rather than identity.
- Custom service / request naming — for service-detection / request-routing problems specifically.

Before proposing a rule, call dt_get_process_properties on a representative entity to see what stable signals exist (env vars, host group, k8s labels). Prefer fields with stability='stable' over 'fragile'. If nothing stable exists, the recommendation is often "set DT_TAGS on the process" rather than a fragile rule.

Before constructing any payload for the write MCP, call dt_get_schema(schemaId) to see exact field names, types, and enum values for the rule you intend to create.

=== PHASE 0 — Bootstrap ===

1. \`dt-ahr\`: \`dt_whoami\` — record the cluster URL, env id, token name, scopes, and expiration. If the token lookup fails with 403, note it; later 403s on tools should be cross-referenced against the scope list (or its absence).
2. Upstream: \`dynatrace_managed_get_environments_info\` and \`dynatrace_managed_check_config_errors\`. Confirm version ≥ 1.328.0 and no errors.
3. \`dt-ahr\`: \`dt_list_schemas\`. Confirm these schemas exist and note any missing:
   builtin:tags.auto-tagging, builtin:management-zones,
   builtin:process-group.advanced-detection-rule, builtin:process-group.detection-flags,
   builtin:service-detection.full-web-service, builtin:service-detection.full-web-request,
   builtin:service-detection.external-web-service, builtin:service-detection.external-web-request,
   builtin:service.request-naming, builtin:service.request-attributes,
   builtin:alerting.maintenance-window.
4. Read the three \`dt-spec://\` resources (\`env-v2\`, \`env-config-v1\`, \`cluster-v1\` if accessible). Note cache paths.
5. STOP and print Phase 0 summary including: who-am-i token scopes, cluster version, missing schemas (if any).

=== PHASE 1 — Hosts & Host Groups ===

Inventory:
- Upstream \`dynatrace_managed_discover_entities\` for HOST_GROUP, then HOST. Use \`get_entity_details\` when richer fields are needed.
- Per host, capture: name, OS, monitoring mode, host group, all tags (each with \`context\` + \`key\` + \`value\` + \`stringRepresentation\` + source when inferable), custom host metadata, management zones.

Tag taxonomy — DERIVE IT, DO NOT ASSUME (engine-backed via the 3-round loop; see Tag-strategy discipline above):
- Round 1 — call \`dt_get_tag_snapshot\` with \`lowTagThreshold: 1\` and \`graphMode: "low_tag_only"\` (default). The engine returns per-type counts, per-key coverage / value-format / context distribution, key similarity clusters (typos), low-tag entities with subgraph, propagation hints. Use this output AS the per-key taxonomy section of phase-1.md — do not re-compute by hand.
- Round 2a — for each ownership-style key that came back at <60% coverage or messy (likely candidates: \`team\`, \`owner\`, \`product\`, \`env\`, \`tier\`), call \`dt_extract_tag_signals\` with the target key and the low-tag entity ids from Round 1. The engine returns candidate values per entity from env vars / AWS+GCP+Azure tags / k8s labels / graph neighbors, with confidence + a consensus pick. Use these candidates to ground the "propagation source" in your remediations — don't guess.
- Round 2b — once you've drafted a proposed strategy (per-key extraction recipe), call \`dt_simulate_tag_strategy\` with the proposal. The engine returns simulated % coverage per key + the uncovered entities. Iterate the strategy until simulated coverage clears your threshold; only then commit the strategy to the report.
- Bucket the engine's per-key output into the operator's mental model for the report:
  - Keys with coverage ≥ 60% → "consensus" keys. These are the tags the account is de facto using.
  - Keys with 10–60% coverage → "inconsistent rollout" — flag with coverage %.
  - Keys with < 10% coverage → "long tail / ad-hoc" — list at most 20, collapse the rest into a count.
- Headline finding: report whether the overall shape looks disciplined (few consensus keys, high coverage, stable values) or messy (many sparse keys, duplicated manual/auto pairs, inconsistent values). Cite the snapshot's similarity clusters as evidence for "messy".

Host Group hygiene:
- Hosts with no host group
- Host groups with a single host
- Host groups with generic names (technology-only like \`java\`, \`node\`, or just the hostname)
- Host groups mixing OS families or roles (infer role from tags/metadata)

Host & Host-Group naming hygiene (engine-backed — run this BEFORE tag-strategy work because name-based tag rules are unreliable when entities have generic names like \`ip-10-0-1-23\` or \`:80\`):
- \`dt_audit_host_naming\` — flags hosts with generic display names and returns ranked candidate names from cloud tags / k8s labels / FQDN / dominant process group / fleet-mate match. Output is bucketed (high_confidence / ambiguous / no_signal).
- \`dt_audit_host_groups\` — five-category report: hostsWithoutGroup, splitFleets (same workload scattered across groups), singleMemberLikelyTypos, genericGroupNames, namingDrift.
- Decision lattice (enforced in code by \`dt_apply_host_clarifying_tag\`):
  - high_confidence → propose source='engine_high' (chosenName must equal engine's topCandidate)
  - ambiguous → propose source='ai_proposed' with a 1-2 sentence rationale; chosenName MUST be in the engine's candidate list (you cannot invent names)
  - no_signal → DO NOT propose; mark for manual review or use operator_override (which is loudly logged)
- After operator approval, call \`dt_apply_host_clarifying_tag\` with reports + decisions to write \`name:<chosenName>\` tags. Downstream tag rules then match \`tag(name:orders-api)\` reliably.
- For host-group findings: call \`dt_export_hostgroup_remediation\` with operator-picked findings to generate oneagentctl shell commands. Host-group membership can't be changed via API; the MCP NEVER runs the commands — present them to the operator.

Tag hygiene (derived, NOT against a user-provided taxonomy):
- Consensus keys missing on a minority of hosts (name the hosts — these are likely the real outliers)
- Manual (\`CONTEXTLESS\`) keys that duplicate a value an auto-tag already provides — candidates to retire manual tags
- Manual clusters that look uniform enough to be replaced by an auto-tag rule
- Keys with messy value formats (show 3 example values)

Auto-tag rule audit:
- \`dt_get_auto_tags\` → filter rules whose conditions target HOST.
- For each rule record: enabled/disabled, rule name, number of value mappings, condition summary. Using the host inventory, classify each rule as:
  - healthy (matches intended-looking subset)
  - overbroad (matches nearly everything)
  - dead (matches zero hosts)
  - fragile (condition depends on a manual tag or custom metadata key with <50% coverage)
  - duplicate (two rules produce the same tag value on the same set)
  - mis-scoped (applies at HOST but the intent reads like PG/PGI)

Overlay (only if expected keys were provided in session inputs):
- For each expected key, report coverage %, whether it's a consensus key, and which hosts lack it.

Monitoring health (also Phase 1):
- \`dt_get_oneagent_versions\` — version distribution, autoUpdate setting distribution, faulty-version count, count of hosts >5 minor versions behind latest. Flag: many versions in flight (rolling update lag), autoUpdate=OFF on a meaningful share, any faulty=true.
- \`dt_get_activegate_versions\` — version distribution, type breakdown, count not currently connected, misconfigured modules. Flag: AGs offline, AGs many versions behind, AGs with misconfigured modules.

Per-host module + technology coverage (mandatory):
- \`dt_get_oneagent_module_status\` — produces these specific findings:
  - \`fullStackHostsWithoutLogs\` — every host in FULL_STACK monitoring mode where the log monitoring module is missing or disabled. List each host (name + entityId) and recommend either enabling the log module or downgrading the host to INFRASTRUCTURE if logs aren't intended on it.
  - \`techGapHosts\` — every host where OneAgent detected a technology (Java, Node, .NET, etc.) that has no matching enabled module. List each host with the detected tech vs the enabled modules. Recommend: enable the tech-specific monitoring module, or document why this tech is intentionally excluded.
  - \`misconfiguredHosts\` — modules flagged misconfigured by OneAgent itself.
- \`dt_get_oneagent_features_and_enrichment\` — confirm metadata/context enrichment is enabled (otherwise env-var → tag flow recommended in remediations doesn't work) and that log-agent feature flags aren't disabling capture. If enrichment is off, EVERY auto-tag rule recommendation that keys on env vars must include "enable metadata enrichment first" as a prerequisite.

When the strategy artifacts (suggested tagging strategy, auto-tag strategy) reference env vars as the value source, they MUST verify enrichment is on. If not, the strategy includes a Wave 0 entry: "enable hostmonitoring.metadata-enrichment before any env-var-keyed auto-tag rule can produce values".

Output: \`${reportDir}/phase-1.md\` with sections — Inventory, De-facto Tag Taxonomy, Host Group Hygiene, Host & Host-Group Naming Hygiene (engine reports + decisions applied or pending), Tag Hygiene, Auto-tag Rule Audit, Monitoring Health (OneAgent + ActiveGate), Per-Host Module + Tech Coverage, OneAgent Features + Enrichment, Remediation (High/Medium/Low). Append a short section to \`${reportDir}/report.md\`. STOP.

=== PHASE 2 — Process Groups & Process Group Instances ===

Inventory upstream PROCESS_GROUP and PROCESS_GROUP_INSTANCE with details (technology, tags, exe path, exe name, cmdline, listening ports, env vars, host + host group).

Checks:
- Wrong grouping: PGIs under one PG with divergent exe paths/cmdlines, or spanning multiple environments / host groups
- Generic PG names (\`java\`, \`node\`, exe-only)
- Do NOT flag many small PGs that are the same app on different hosts — that is expected
- Missing or inconsistent tags at PG and PGI level
- Cases where \`DT_CLUSTER_ID\` / \`DT_NODE_ID\` / \`DT_TAGS\` env vars would cleanly separate or identify instances but aren't set

PG/PGI tag taxonomy — derive via the 3-round loop (same engine path as Phase 1; see Tag-strategy discipline):
- Round 1 — \`dt_get_tag_snapshot\` returns counts + per-key taxonomy across ALL entity types in one call. For the Phase 2 report, focus the sections on \`PROCESS_GROUP\` and \`PROCESS_GROUP_INSTANCE\` from the same snapshot (no need to re-call). Compare per-key coverage against the host-level coverage from Phase 1 to spot keys that "exist on hosts but stop at PG" (a common ownership-propagation gap).
- Round 2a — for ownership-style keys that are weaker on PG/PGI than on hosts, call \`dt_extract_tag_signals\` with the target key. The engine surfaces candidate values from PG/PGI properties (env vars are particularly strong on PGI: \`OWNING_TEAM\`, \`DT_TAGS\`, \`DEPLOYMENT_ENV\`). Cite the consensus pick in remediations.
- Round 2b — if you're proposing a new PG-level extraction strategy, validate with \`dt_simulate_tag_strategy\` before writing it into the report.

Cross-check via dt-ahr:
- \`dt_get_pg_detection_rules\` — for each rule: enabled, condition summary, estimated effect. Flag overbroad / dead / duplicate / mis-scoped.
- \`dt_get_auto_tags\` rules targeting PG or PGI — flag rules that reference properties valid on PG but not PGI (or vice versa).
- \`dt_get_naming_rules\` and \`dt_get_conditional_naming(type='processGroup')\` — list active PG naming rules. Flag generic-named PGs that have no rule covering them, and rules whose condition no longer matches anything (dead rules).
- For any PG with a generic display name, call \`dt_get_process_properties\` on one of its PGIs to identify a stable property that could feed a naming rule (e.g. env var, k8s label, host group).

PG naming hygiene (engine-backed — run this BEFORE deciding the PG taxonomy section above; downstream tag work in later phases assumes PGs are sanely named):
- \`dt_audit_process_group_naming\` — flags PGs with generic display names (port-only, bare technology, Dynatrace defaults) and returns ranked candidate names from JarFile / KubernetesContainerName / CommandLineArguments / JavaMainClass / Docker image tail / softwareTechnologies. Bucketed (high_confidence / ambiguous / no_signal).
- Same decision lattice as Phase 1 host naming: high_confidence → engine_high, ambiguous → ai_proposed (with rationale, names ONLY from engine candidates), no_signal → manual review or operator_override.
- After operator approval, call \`dt_apply_pg_naming_rule\` with reports + decisions to write \`name:<chosenName>\` tags. Downstream tag rules then match \`tag(name:billing-svc)\` even when the PG's display name is still "java".

For each finding map the remediation to one of: \`DT_CLUSTER_ID\` env var, PG detection rule, custom naming rule, tagging rule, or naming-clarity tag (the route the engine-backed naming hygiene step uses).

Output: \`${reportDir}/phase-2.md\` with sections — Inventory, PG Naming Hygiene (engine reports + decisions applied or pending), Wrong Grouping, Tag Coverage, Detection Rules Audit, Auto-tag Rules Audit, Naming Rules Audit, Remediation. Append to \`${reportDir}/report.md\`. STOP.

=== PHASE 3 — Management Zones ===

Inventory via \`dt_get_management_zones\` — count, naming, rule conditions.

Checks:
- Overlap: the same entities appearing in many MZs (use upstream \`discover_entities\` with \`mzName(...)\` selectors to count membership per MZ)
- Dead MZs: 0 entities
- MZs whose matched entities don't semantically fit the MZ name
- Rule hygiene: fragile refs to manual tags vs stable refs to host-group / auto-tag / env-tag

Coverage gaps:
- HOST not in any MZ (count + list)
- PROCESS_GROUP not in any MZ (count + list)
- PROCESS_GROUP_INSTANCE not in any MZ if relevant (count + list)

Ownership-separation gap (mandatory check):
- Cross-reference Phase 1's de-facto host taxonomy and Phase 2's PG taxonomy. Identify ownership keys (\`team\`, \`owner\`, \`product\`, \`bu\`, \`squad\`, etc.) and their coverage.
- If ownership keys are absent or low-coverage AND there is no auto-tag rule producing a stable ownership tag, flag this as a HIGH-priority finding: ownership separation is impossible without it.
- Recommendation must include both halves:
  1. Establish the ownership tag — propose either an auto-tag rule keyed on a stable signal (env var, host group, k8s label) or DT_TAGS at deploy. Compare alternatives per the remediation discipline.
  2. Once the tag exists, create per-owner MZs that select on that tag — so each owner sees only their own entities, alerting profiles route correctly, and access scopes follow.
- If ownership tags exist but MZs don't use them (MZs reference manual tags or hostnames instead), flag this too: the tags are wasted unless MZs key off them.
- If MZs and ownership tags are both healthy but there are still owners with no MZ, list the missing owner → recommend an MZ.

Ownership readiness — explicitly cross-reference Phase 1's auto-tag findings with the MZ rules:

- From the de-facto tag taxonomy collected in Phase 1 (and Phase 2 for PG-level), identify any keys that look like ownership/identity signals — heuristic candidates: \`team\`, \`owner\`, \`squad\`, \`tribe\`, \`product\`, \`application\`, \`service-owner\`, \`cost-center\`, \`bu\`, \`org\`, \`portfolio\`. Treat both manual and auto-sourced keys as candidates, but prefer auto-sourced.
- Check each MZ rule: does it reference any of those ownership keys, OR does it rely on something fragile (manual tag, hostname pattern, host group as a stand-in for owner)?
- Three cases to distinguish in the report:

  1. **MZs are aligned with ownership** — at least one ownership-style auto-tag exists AND most MZ rules reference it. Healthy. Note it as a positive finding.

  2. **Ownership tags exist but MZs don't use them** — auto-tag like \`team\` is present and well-covered, but MZs are still carved by hostname/manual tag/host group. Recommendation: rewrite the MZ rules to key off the existing ownership auto-tag. Stable, no new rule needed.

  3. **No ownership signal exists at all** — no \`team\` / \`owner\` / \`squad\` / \`product\` style key in the de-facto taxonomy, OR such a key exists but with <30% coverage. This is the most important finding in Phase 3. Recommend, in this order:
     a. Create an ownership auto-tag rule (\`builtin:tags.auto-tagging\`) — sourced from a stable signal (env var like \`OWNER\` / \`TEAM\` on the process, k8s label, or host-group naming convention). Without this, every MZ built today will rot.
     b. Once the ownership tag exists and reaches >80% coverage, carve management zones along it — one MZ per owner.
     c. Highlight that until step (a) lands, creating new MZs is premature — they will be fragile and will need to be recarved.

This must be a top-of-Phase-3 callout, not buried at the end.

Output: \`${reportDir}/phase-3.md\` with sections — Inventory, Hygiene Issues, Coverage Gaps, **Ownership Readiness** (highlighted), Remediation. Append to \`${reportDir}/report.md\`. STOP.

=== PHASE 3.5 — Maintenance Windows ===

\`dt_get_maintenance_windows\` — pulls both Settings 2.0 and Config v1 surfaces.

Checks:
- Dead MWs — disabled/expired but still present
- Perma-MWs — recurrence + scope that is effectively always-on, masking real alerts
- Scope-less MWs — apply to everything (no entity selector / management zone)
- Overlapping MWs covering the same scope simultaneously
- MWs with very large scope (a whole MZ or entire env) — flag for review

Output: \`${reportDir}/phase-3-5.md\`. Append to report. STOP.

=== PHASE 3.7 — Davis Health & Entity Hygiene ===

Davis problem signal:
- \`dt_get_problem_history\` with from='now-30d' — MTTR (overall, p50, p95), top recurring root entities, top problem categories, stuck-open count (>7 days). Findings:
  - High p95 MTTR with stable mean = a small number of problems are sitting open for days
  - Same root entity producing many problems = AD too sensitive OR a real reliability issue at that entity
  - Stuck-open problems = triage backlog; flag the IDs

Entity hygiene:
- \`dt_get_entity_orphans\` with from='now-24h' — SERVICE without backing PG (broken detection), HOST with no monitored PG (silent host), zombie PGs (all PGIs gone), inactive hosts (>7d since lastSeen).
- \`dt_get_orphan_settings_scopes\` — Settings 2.0 objects scoped to entity ids that no longer exist. Cleanup candidates.

Cross-reference: stuck-open problems whose root entity is also in the entity-orphans list = problem about a thing that no longer exists. Auto-close candidate.

Output: \`${reportDir}/phase-3-7.md\`. Append to report. STOP.

=== PHASE 4 — Services ===

Inventory:
- Upstream \`dynatrace_managed_discover_entities\` for SERVICE — bucket by technology, MZ membership, owning PG.
- For each SERVICE, capture name, technology, backing PG ids, MZ membership, tags (with context).

De-facto SERVICE tag taxonomy — engine-backed via the 3-round loop (see Tag-strategy discipline). Same engine snapshot that Phase 1/2 used carries SERVICE rows too — you do NOT re-fetch:
- Round 1 — \`dt_get_tag_snapshot\` (if not already cached from earlier phases). Read off the \`SERVICE\` slice of the per-key coverage map. Use this for the headline "do ownership keys propagate to services or stop at PG?" finding: compare per-key coverage SERVICE vs PROCESS_GROUP — a sharp drop signals propagation is blocked at the PG → service boundary.
- Round 2a — for any ownership key with weak SERVICE coverage, call \`dt_extract_tag_signals\` with target=that key. The engine traverses the SERVICE → PGI → PG → HOST containment chain and surfaces upstream candidates ("this service is backed by PGs that DO have \`team=orders\` — propagate via call chain"). Use these as the propagation-recipe evidence.
- Round 2b — \`dt_simulate_tag_strategy\` on the proposed SERVICE-level extraction recipe before committing to the Phase 4 strategy section.
- \`dt_list_tags_for_entity type(SERVICE)\` is still useful for spot-checks on individual services, but the snapshot is the source of truth for the taxonomy section.

Detection / grouping hygiene:
- \`dt_get_service_detection_rules\` — for each rule: enabled, condition validity, dead, overbroad, duplicate, mis-scoped.
- Wrong grouping signals:
  - One SERVICE backed by PGIs spanning multiple envs/host-groups → likely missing detection rule that should split it
  - Many SERVICEs that look like the same logical app on different hosts → likely missing rule that should merge them (the inverse problem)
- Note custom services found via the detection-rule schemas; check whether they're still hit (use upstream metrics for requestCount).

Naming hygiene:
- Generic SERVICE names (e.g. 'Web service on port 8080', exe-only, hostname-only).
- \`dt_get_conditional_naming(type='service')\` and \`dt_get_naming_rules\` (Settings 2.0 service-naming candidates) — list active rules.
- Cross-reference: which generic-named services have NO naming rule covering them?
- For each, call upstream \`get_entity_details\` on a backing PGI then \`dt_get_process_properties\` to find a stable signal (env var, k8s label, host group) that could feed a service naming rule.

Request shaping (v1 + v2 coexist — audit both):

V1 surface — OneAgent-detected services (Java / .NET / Node / PHP / Go deeply instrumented by OneAgent):
- \`dt_get_service_detection_rules\` — v1 rules across full-web-service, full-web-request, external-web-service, external-web-request schemas.
- \`dt_get_request_naming\` — v1 request-naming + request-attributes.
- For the top 10–20 services by traffic (use upstream \`query_metrics_data\` with \`builtin:service.requestCount.total\` to rank), call \`dt_get_service_request_cardinality(serviceId)\` — services with isHighCardinality=true are the strongest candidates for new request-naming rules.

V2 surface — k8s-discovered services + OTel-instrumented services (these don't go through OneAgent's full-web-request pipeline):
- \`dt_get_v2_service_detection\` — covers builtin:service-detection-rules, builtin:service-splitting-rules, builtin:endpoint-detection-rules, builtin:url-path-pattern-matching-rules, builtin:unified-services-endpoint-metrics, builtin:apis.detection-rules.
- The "URL path pattern matching" tab is the v2 equivalent of v1 request-naming for k8s/OTel services. Audit the same way: dead patterns (no matches), too-broad, too-narrow, missing patterns for high-cardinality services.

Coexistence audit (mandatory — common misconfiguration source):
- For each finding about a service, identify whether the service is OneAgent-detected (v1) or k8s/OTel-detected (v2). Use upstream \`get_entity_details\` on the service: properties.agentTechnologyType, presence of k8s metadata, presence of OTel resource attributes.
- Flag rules in the wrong tab: a v1 rule scoped to a v2-detected service will not fire (and vice versa). The fix is to recreate the rule on the correct surface.
- Flag the same logical concern handled twice (e.g. a v1 request-naming rule AND a v2 url-path-pattern rule both trying to normalize \`/users/{id}\`) — pick one source of truth.

URL path matcher choice (applies to BOTH v1 conditions and v2 patterns):
- Pick most specific available: EQUALS > BEGINS_WITH > ENDS_WITH > CONTAINS > MATCHES_REGEX.
- Use BEGINS_WITH for "all my service's traffic" anchored on API root.
- Use segment-at-position when path shape is stable.
- Reach for regex only when capture groups are needed (extracting \`{id}\` for substitution) or alternation can't be expressed with glob.
- Avoid CONTAINS for production rules — too broad. Pair with at least one anchored condition.
- Watch for: trailing-slash mismatch, case sensitivity, query-string-vs-path confusion, URL-encoded segments, catch-all rules eating specific rules (DT processes top-down, first match wins for naming).

Request attributes audit (v1):
- Are attributes used downstream (in dashboards / SLOs / calculated metrics / request-naming rules)? Dead attributes = clutter.
- Sensitive-data attributes = security risk — flag any that look like they extract PII (auth headers, session ids, customer ids).

Failure detection (separate concern, audit it here while we're in services):
- \`dt_get_failure_detection\` — rulesets + environment rules + parameters + HTTP failure params. Flag: rules causing noise (every 5xx alerted), missing rules for known-bad-but-not-default (e.g. partial-success states the customer cares about).

Trace sampling + ingest control (cost driver, also folded into Phase 5):
- \`dt_get_trace_sampling_and_ingest\` — HTTP/RPC sampling, env + global trace ingest control, muted requests. Flag: no sampling at all (max cost), overbroad mute (silently dropping useful traces), conflicting rate caps.

Calculated service metrics:
- \`dt_get_calculated_service_metrics\` — pulls Settings 2.0 (multiple candidate schemas) AND Config v1. Flag: dead metrics (defined but unused), redundant (multiple measuring the same thing), overly broad scope.

SLO hygiene (use upstream MCP):
- \`dynatrace_managed_list_slos\` — inventory.
- For each: \`dynatrace_managed_get_slo_details\` — current vs target, error budget remaining, days to breach at current burn rate.
- Flag dead SLOs (never evaluated, target unreachable like 99.999% on a flaky service, scope matches 0 services), SLOs not attached to an alerting profile (silent), and coverage gaps (SERVICEs with frequent problems but no SLO — cross-reference upstream \`list_problems\` filtered to type SERVICE).

Anomaly detection on services:
- \`dt_get_service_anomaly_detection\` — global config plus per-service overrides. Flag: services with disabled AD, services with hyper-sensitive thresholds (likely noise sources), services with no overrides where one would help (high-traffic, high-error-variance services).

Ownership readiness for services (mirror Phase 3):
- If ownership tags exist on hosts/PGs but NOT on services, recommend an auto-tag rule scoped to SERVICE that derives ownership from the owning PG's tags or the PGI's env vars / k8s namespace.
- MZs covering services should reference the ownership tag.

Cross-cutting:
- Orphan SERVICEs (no PG attached) — broken detection.
- Dead SERVICEs (0 traffic over the window).
- Top DDU-traces consumers (tie back to Phase 5 cost): if DDU-traces is high in Phase 5, the top traffic services from this phase are the explanation.
- Long-tail SERVICEs (<N requests/day) — clutter; candidates for "ignore in detection rules".

Output: \`${reportDir}/phase-4.md\` with sections — Inventory, De-facto Service Tag Taxonomy, Detection Hygiene, Naming Hygiene, Request Shaping (incl. cardinality), Calculated Metrics, SLO Hygiene, Anomaly Detection, Ownership Readiness, Cross-cutting, Remediation (High/Medium/Low). Append to \`${reportDir}/report.md\`. STOP.

=== PHASE 4.5 — Alerting & Notifications ===

Reads:
- \`dt_get_alerting_profiles\` — list profiles. Flag: profile referencing a dead/non-existent MZ; profile with no problem-severity coverage; orphaned profile with no entities matching its scope; missing profile for a given owner (cross-ref ownership tags from Phase 3).
- \`dt_get_problem_notifications\` — Slack/Teams/email/webhook integrations. Flag: dead integrations (URL no longer valid is hard to test, but check 'enabled=false' or 'lastSendStatus' if present); profiles with no integration attached (silent alerting); a single integration on too many profiles (single point of failure).
- \`dt_get_anomaly_detection\` — already pulled in earlier checks; tie back here: noisy categories (metric-events, infra) drive notification volume.

Output: \`${reportDir}/phase-4-5.md\`. Append to report. STOP.

=== PHASE 4.6 — Audit & Governance ===

Reads:
- \`dt_get_audit_log_settings\` — confirm audit logging is enabled; flag if categories are too narrow.
- \`dt_get_audit_log_entries\` with from='now-30d' — recent activity. Flag: bursts of config churn (>N changes/day from one user, e.g. an automation that's flapping), failed events (success=false), unexpected user types (CLUSTER_USER making env-config changes).
- \`dt_get_ownership_teams\` — list teams. Cross-ref against ownership tags found in Phase 1/2/4: every team referenced in a tag should exist as an ownership record; every ownership record should have at least one entity tagged.
- \`dt_get_extensions\` — installed Extensions 2.0. Flag: extensions with multiple versions in flight (rolling update lag), extensions from unknown authors, extensions duplicating native coverage.

Reads (continued):
- \`dt_get_api_tokens\` — security finding: tokens with no expiration, expired-but-listed, never-used, unused for 90+ days, high-privilege (write) tokens, broad scope distribution. Cross-reference against the audit log to find the user who created each.
- \`dt_get_oauth_clients\` — same shape for OAuth clients (returns 'available: false' on older Managed versions, no error).
- \`dt_get_recently_changed_settings\` with days=30 — config churn surface. Cross-reference with audit log entries to attribute changes. Flag schemas with disproportionate change counts (e.g. auto-tags changed 47 times in a week = unstable / experimentation).

Output: \`${reportDir}/phase-4-6.md\`. Append to report. STOP.

=== PHASE 4.7 — Cloud & Integration Surface ===

Reads:
- \`dt_get_cloud_integration\` — AWS/Azure/GCP/K8s/CloudFoundry/VMware. Flag: configured-but-disabled integrations, integrations with credential errors (look in audit log for failures), unmonitored cloud accounts (entities with cloud-context tags but no integration record).
- \`dt_get_opentelemetry_config\` — OTel ingestion settings if enabled. Flag overlap with OneAgent on the same services (double-instrumentation cost).
- \`dt_get_synthetic_monitors\` — synthetic monitors inventory. Flag: disabled monitors left in place, monitors with no linked application, locations the cluster can't reach.
- \`dt_get_appsec_config\` — Vulnerability Analysis, Runtime Application Protection, Code-level Vulnerability, Environment Coverage, AppSec alerting. Flag: AppSec on but no alerting profile attached; environment coverage gaps.
- \`dt_get_rum_config\` — RUM injection / user tagging / user-action naming / key user actions / session properties / conversion goals / RUM metrics / session replay. Flag: app injection mode mismatch with traffic, missing user-action naming on high-traffic apps, session replay enabled with no masking rules.
- \`dt_get_business_events\` — Business Events ingest config. Flag: no rules but DDU billing shows BizEvents consumption.
- \`dt_get_release_monitoring\` — release events config. Flag: no release events ingested but customer says they deploy daily.
- \`dt_get_dashboards_inventory\` — dashboards via Config API v1. Flag: orphaned dashboards (owner no longer a user), unshared dashboards that dominate by count (knowledge silos).
- \`dt_get_custom_services_and_key_requests\` — custom service definitions + key request subscriptions. Cross-ref Phase 4 service findings.

Output: \`${reportDir}/phase-4-7.md\`. Append to report. STOP.

=== PHASE 4.8 — RUM & Frontend Applications ===

Inventory:
- \`dt_get_rum_app_inventory\` — discovers APPLICATION (web), MOBILE_APPLICATION, CUSTOM_APPLICATION entities with per-app session count over the 1d window. Flag: dead apps (sessionCount=0), apps with no tags, apps with generic auto-names.
- Tag taxonomy on RUM apps — separate de-facto pass via \`dt_list_tags_for_entity type(APPLICATION)\` and the mobile/custom equivalents. Compare to Phase 1 host taxonomy and Phase 4 service taxonomy: do ownership keys propagate to frontends?

Per-app feature matrix (mandatory — the headline of this phase):
- \`dt_get_rum_app_feature_matrix\` — for each app, audits ~25 features across:
  - Session Replay (web + mobile) — enabled? privacy preferences set?
  - RUM enablement / capture rate per app
  - User tagging / custom errors / KUAs / session properties / conversion goals
  - User-action naming rules (web + mobile)
  - Apdex thresholds (load / xhr / custom / mobile)
  - Resource cleanup, exclusions (XHR / IP / browser)
  - Privacy preferences
  - Per-app anomaly detection override
  - Request error rules
- For each app, the matrix returns per feature: status (configured-explicit | configured-via-default | missing | n/a), enabled flag where applicable, scope (per-app override or env default), objectId, recommendation if missing.
- HEADLINE FINDING: produce a per-app summary table with columns: appId, sessionCount, missingFeaturesCount, disabledFeaturesCount, top-3-missing. Sort by sessionCount desc — highest-traffic apps with the most gaps go to the top of the remediation backlog.

App detection hygiene:
- \`dt_get_rum_config\` — pull \`builtin:rum.web.app-detection\` and check: catch-all default app eating traffic, broken regex, multiple apps mapping to the same domain (leakage), beacon-domain-origins / beacon-endpoint reachability concerns.
- \`builtin:rum.processgroup\` — RUM ↔ backend service linkage. Apps with no linked PG = no service-side correlation possible.

User-action cardinality:
- For top 5 apps by sessionCount that have user-action-naming.web in "missing" status, the agent should compute distinct action name count via raw metric query (\`builtin:apps.web.actionCount.category:splitBy("dt.entity.user_action_name")\`) — analog of dt_get_service_request_cardinality. >100 distinct = naming rule needed.

Cost / enablement (cross-reference with Phase 5):
- Capture rate × sessionCount = billed sessions per app. Tie back to \`builtin:billing.usersession.user_session_count\`.
- Apps with capture rate at default (often 100%) AND high traffic = primary cost reduction targets.

Privacy & masking (config audit only — DO NOT read actual session data):
- Per app with Session Replay enabled, confirm \`builtin:sessionreplay.web.privacy-preferences\` is also set. Replay without privacy = compliance risk.
- \`builtin:rum.user-tagging\` — if user-tagging is configured, flag for human PII review. The agent shouldn't decide whether the captured user-id field is OK; just surface it.

Mobile-specific:
- For each MOBILE_APPLICATION: beacon endpoint configured? Privacy settings explicit? Crash-rate AD threshold tuned per app or global default?

RUM ↔ Synthetic linkage:
- Cross-reference \`dt_get_synthetic_monitors\` + \`builtin:synthetic.browser.assigned-applications\` + \`builtin:synthetic.http.assigned-applications\`.
- Coverage gap: high-traffic prod app with no synthetic check.
- Wasted: synthetic monitor assigned to an app that's now dead (sessionCount=0).

Custom metrics & session export:
- \`builtin:custom-metrics\`, \`builtin:user-action-custom-metrics\` — defined vs consumed downstream.
- \`builtin:elasticsearch.user-session-export-settings-v2\` — if exporting, audit destination + filter.

Cross-cutting:
- Dead apps (0 sessions in 24h) — list candidates for removal
- Orphan apps (no PG linkage)
- Generic-named apps (default DT names like "MyApplication") — flag for renaming

Output: \`${reportDir}/phase-4-8.md\` with sections — Inventory, Tag Taxonomy, Per-App Feature Matrix (the headline), App Detection Hygiene, User-Action Cardinality, Cost / Enablement, Privacy & Masking, Mobile, RUM ↔ Synthetic, Custom Metrics & Export, Cross-cutting, Remediation. Append to \`${reportDir}/report.md\`. STOP.

=== PHASE 5 — Consumption / Cost ===

\`dt_get_consumption_summary\` with from='now-7d' (also re-run with from='now-30d' for comparison).

Checks:
- Which category dominates (host units vs DDU-metrics vs DDU-logs vs DDU-traces vs synthetic vs sessions)
- Categories that look disproportionate vs the apparent size of the deployment (lots of DDU-logs but few hosts → noisy log ingest; lots of DDU-metrics but few custom metrics defined → metric explosion from a custom integration)
- Any category that returned 'available: false' — note for the user (license tier may not include it, or selector changed in this DT version)

Configuration cross-checks (cost-driver evidence, mandatory):
- \`dt_get_process_monitoring_rules\` — list rules. Flag overbroad rules (no condition, applies to all hosts/PGs), redundant rules, and processes monitored that have 0 traffic over the window (waste). Tie to high host-unit / DDU-metrics totals.
- \`dt_get_log_ingestion_rules\` — list rules across the schemas. Flag: log sources with no retention rule, overbroad ingest patterns, missing sensitive-data masking on user-facing logs, metric-extraction rules with no consumer (dead extraction). Tie to high DDU-logs.
- \`dt_get_network_zones\` — list zones. Flag misrouted OneAgents (connecting to AGs in a different zone) which inflates AG bandwidth cost and can cause data gaps.
- \`dt_get_span_capturing\` — sampling and capture rules + span-attribute extraction. Tie to DDU-traces. Flag overbroad capture, missing sampling, attribute extraction with cardinality risk (per-user-id capture).

Tie back to earlier phases:
- High DDU-metrics + Phase 1 found many fragile auto-tag rules → suggest tightening auto-tags reduces metric cardinality
- High DDU-logs + log-ingestion rules show overbroad scope → propose narrowing inclusion patterns or moving low-value logs to a cheaper bucket
- High DDU-traces + Phase 4 found high-cardinality services without request-naming rules → propose request-naming rules to collapse per-id endpoints
- High host-units + Phase 1 found inactive hosts not auto-disabled → propose host autoUpdate / auto-disable settings

Output: \`${reportDir}/phase-5.md\`. Append to report. STOP.

=== FINAL ===

Finish \`${reportDir}/report.md\` with:
- Top-of-file Executive Summary (5–10 bullets) — the headline judgment about tag discipline, grouping health, MZ hygiene, alerting reachability, cost drivers
- Phase 1–5 sections (already appended)
- Consolidated Remediation Backlog ranked High / Medium / Low with concrete actions
- A "Suggested Tagging Strategy" section (see below)
- A "Suggested RUM Strategy" section (see below)

=== SUGGESTED TAGGING STRATEGY (mandatory, in report.md and as JSON) ===

Produce a forward-looking tag taxonomy for this account, derived from the de-facto taxonomies you discovered in Phases 1 (hosts), 2 (PGs/PGIs) and 4 (services), AND consistent with the remediation backlog you just produced. This is not aspirational — every key proposed must be grounded in evidence.

Two artifacts:

1) A "Suggested Tagging Strategy" section in \`${reportDir}/report.md\` covering:
   - **Proposed canonical key set** — table with one row per recommended key. Columns:
     - \`key\` (e.g. \`env\`, \`team\`, \`product\`, \`tier\`, \`component\`, \`bu\`)
     - \`scope\` — which entity types this key should appear on (HOST / PG / PGI / SERVICE; usually all four for ownership keys)
     - \`source of truth\` — where the value comes from (env var on process, k8s label, host group name, AWS tag, host metadata, manual tag)
     - \`recommended mechanism\` — DT_TAGS env var | auto-tag rule | host metadata | k8s passthrough | manual (last resort)
     - \`current coverage\` — coverage % observed today across the relevant entity types (cite phase artifact)
     - \`target coverage\` — what coverage to aim for (usually 95%+ for ownership keys)
     - \`value format rule\` — e.g. "lowercase, hyphenated, no spaces" — pinned to what's already most common in the data
     - \`enum (if bounded)\` — if you observed a small finite value set (e.g. env: prod / staging / dev), list it
     - \`evidence\` — at least one citation from raw/ explaining why this key was chosen (coverage observed, k8s label present, env var observed)
   - **Keys to retire** — table of currently-present keys that should be deprecated. Columns: \`key\`, \`reason\` (duplicate of canonical / sparse / messy values / superseded by an auto-tag), \`migration path\` (e.g. "remap to canonical \`team\`"), \`evidence\`.
   - **Value-format normalization plan** — for each canonical key, the dominant casing / shape observed and the rule to enforce going forward. Cite the value-format-consistency findings from the discovery passes.
   - **Implementation phases** — group the proposed keys into rollout waves (Wave 1: highest-impact + highest-evidence keys; Wave 2: secondary; Wave 3: nice-to-have). Each wave references the remediation backlog entries (REM-NNN ids) that implement it.
   - **Cross-entity propagation rules** — explicit rules for how a key flows between layers. Example: "\`team\` is set as DT_TAGS env var on the PGI; auto-tag rule \`team-from-pgi\` propagates it to the SERVICE; host inherits via host group naming convention."
   - **Anti-patterns to avoid** — short list, derived from what went wrong in the current state (e.g. "no manual \`team\` tags — they always drift to inconsistent casings").

2) \`${reportDir}/tagging-strategy.json\` — machine-readable form of the same. Each canonical key as an object, plus arrays for retirement, normalization, waves, propagation rules. This is the input the write MCP uses (alongside the remediation-backlog.json) to actually implement the strategy.

Discipline:
- The proposed strategy must be CONSISTENT with the remediation-backlog.json — if a backlog entry creates an auto-tag rule for \`team\`, the strategy must list \`team\` as a canonical key with mechanism="auto-tag rule" and reference the REM-NNN id.
- Every canonical key must trace back to evidence in the raw bundle. Don't propose keys the data doesn't support — call those out separately under "potential future keys (need data)" if you think they'd be valuable.
- If the de-facto state is healthy in some area (e.g. \`env\` already at 98% coverage with consistent values), the strategy should ratify it ("keep \`env\` as canonical, current state is healthy, no action") — not propose change for change's sake.
- Cross-reference Phase 3 (MZs) and Phase 4.5 (alerting profiles): the canonical keys must be ones that MZs and alerting profiles can reasonably select on. If a key is proposed but no MZ/profile uses it, flag it.

=== SUGGESTED PROCESS-GROUP DETECTION STRATEGY (mandatory) ===

Produce a forward-looking PG detection strategy derived from Phase 2's findings. The goal: every distinct logical "thing" the customer cares about lives in its own PG, no PG mixes unrelated things, no PG is a hostname-only or exe-only blob.

Two artifacts:

1) "Suggested PG Detection Strategy" section in \`${reportDir}/report.md\` covering:
   - **Detection identity policy** — the canonical signal the strategy will use to define PG identity (env var like DT_CLUSTER_ID, k8s workload, exe path + listen port, etc.). Pick ONE primary, with 1–2 fallbacks. Justify with evidence (which signal had the highest coverage and lowest fragility per Phase 2's dt_get_process_properties scan).
   - **Per-application detection rules** — table with one row per logical app/service in the inventory. Columns:
     - \`logical name\` (the app the customer would call it — e.g. "checkout-api", "payments-worker")
     - \`current state\` ("3 separate PGs but should be one" / "1 PG mixing 4 different envs" / "named 'java' generically")
     - \`proposed rule type\` (split / merge / restrict / rename) — see Phase 2 wrong-grouping signals
     - \`condition\` (the exact condition string this rule will use, e.g. \`envVar(OWNING_TEAM) = "payments" AND executableName = "java"\`)
     - \`expected resulting PG count\` (e.g. "splits 1 → 4 PGs")
     - \`backlog REM ids\` — the entries in remediation-backlog.json that implement it
     - \`evidence\` — raw artifact + counts (e.g. "phase2-pgis-all.json, 47 PGIs under PROCESS_GROUP-A1B2 span 3 envs and 5 host groups")
   - **Defaults to apply globally** — settings on builtin:process-group.detection-flags that should be on/off by default (e.g. "use Docker container name as identity: ON because we observe k8s on 80% of hosts").
   - **What NOT to detect on** — explicit anti-patterns observed in Phase 2 (e.g. "do not key on cmdline because we observed hash-suffixed jars in 60% of cases").
   - **Implementation waves** — same wave concept as the tagging strategy. Each wave references REM-NNN ids.

2) \`${reportDir}/pg-detection-strategy.json\` — machine-readable form. Each per-application rule as an object with the same fields.

Discipline:
- A "split" recommendation must cite the evidence of mixing (envs spanned, host groups spanned, divergent exe paths or cmdlines).
- A "merge" recommendation must cite the evidence of fragmentation (N PGs for the same logical app on N different hosts, all with identical exe paths).
- Every rule must rely on properties marked stability='stable' or 'moderate' from dt_get_process_properties. If only 'fragile' signals exist, the recommendation is "set DT_TAGS or DT_CLUSTER_ID at deploy" rather than a fragile detection rule.

=== SUGGESTED SERVICE NAMING STRATEGY (mandatory) ===

Produce a forward-looking service naming strategy derived from Phase 4's findings. The goal: no SERVICE has a generic auto-name; every service display name reflects the logical service the customer would call it.

Two artifacts:

1) "Suggested Service Naming Strategy" section in \`${reportDir}/report.md\` covering:
   - **Naming source-of-truth policy** — what signal is used to construct the name (env var on PGI like APP_NAME, k8s service name, request-attribute, host group + tech). Pick ONE primary with 1–2 fallbacks. Justify with evidence.
   - **Per-service naming rules** — table with one row per service that needs a rule:
     - \`current display name\` (often generic like "Web service on port 8080")
     - \`proposed display name pattern\` (e.g. "{owning_pgi.envVar(APP_NAME)} ({tech})")
     - \`backing PGI signal cited\` — the stable property the rule keys on, with evidence path
     - \`scope\` — single SERVICE id, or a SERVICE selector covering many at once
     - \`backlog REM ids\`
     - \`evidence\`
   - **Naming rule template families** — group similar rules into reusable patterns (e.g. "k8s-served-services", "java-springboot-services", "external-web-services"). One template per family, each instantiated for N services.
   - **Request naming policy (separate from service naming)** — top-N services per Phase 4's cardinality scan that need request-naming rules; for each, the proposed placeholder pattern (e.g. \`/user/{id}\` instead of \`/user/123\`). Cite the cardinality count.
   - **Implementation waves** — by impact (high-traffic services first), referencing REM-NNN ids.

2) \`${reportDir}/service-naming-strategy.json\`.

Discipline:
- Every per-service rule must trace to a stable signal on the backing PGI, surfaced via dt_get_process_properties. If no stable signal exists, the recommendation flips to "establish the signal first (DT_TAGS, env var, host group rename) THEN add the naming rule" — and that becomes a chain of REM entries.
- Don't propose naming rules for services that are already correctly named — ratify them.

=== SUGGESTED REQUEST RULES STRATEGY (mandatory) ===

Produce a forward-looking strategy for v1 Full/External-Web-Request rules AND v2 URL path pattern matching rules. These are TWO separate config surfaces that coexist; the strategy must call out which surface each recommendation belongs on.

Two artifacts:

1) "Suggested Request Rules Strategy" section in \`${reportDir}/report.md\` covering:
   - **v1 vs v2 surface decision** per recommendation. For each service that needs a request rule, classify the service:
     - OneAgent-detected (Java/.NET/Node/PHP/Go deep instrumentation) → v1
     - k8s-discovered / OTel-instrumented → v2
     - Use upstream \`get_entity_details\` on the service to determine.
   - **Inbound rules table** (rule_type one of full-web-request-split / -merge / -rename / -ignore, OR v2 url-path-pattern-add / -modify / -delete). Per row:
     - service id + name
     - surface (v1 | v2)
     - schemaId for the rule (e.g. \`builtin:service-detection.full-web-request\` or \`builtin:url-path-pattern-matching-rules\`)
     - current state (cardinality count from dt_get_service_request_cardinality, top sample request names, evidence path)
     - proposed condition (with the URL path matcher choice — EQUALS / BEGINS_WITH / ENDS_WITH / CONTAINS / MATCHES_REGEX / segment-at-position — picked per the matcher decision rules in WORKING RULES)
     - proposed modification (custom request name with \`{placeholder}\`, split-by, ignore, etc.)
     - expected outcome (e.g. "cardinality drops from 247 → ~20")
     - verification step (re-run dt_get_service_request_cardinality after apply)
     - backlog REM ids
     - evidence
   - **Outbound rules table** (external-web-request-split / -merge / -rename, same columns but for external services).
   - **Add-when / skip-when checklist applied to each candidate** — confirm against the decision matrix before including:
     - ADD when distinctRequestNames > 100, top-1-2 dominate >80% with generic name, IDs/UUIDs/timestamps in path, multiple frameworks on same SERVICE
     - SKIP when service has < 100 req/day, third-party with no routing control, names already meaningful, already covered by an existing rule
   - **Coexistence findings** — every misplaced rule (v1 rule on a v2 service, duplicate rule on both surfaces). Each gets a remediation entry: delete from wrong surface, recreate on correct surface.
   - **URL path matcher choice rationale** — for each proposed pattern, one-line justification of why the chosen matcher type (e.g. "BEGINS_WITH because path is anchored at API root and we don't need capture groups").

2) \`${reportDir}/request-rules-strategy.json\` — machine-readable form. Each rule entry as an object with the columns above plus a payload field shaped against the actual schema (fetched via dt_get_schema). Entries must be schema-compatible so the write MCP can use them as \`dt_create_settings\` payloads.

Discipline:
- Every entry references the schemaId it targets. v1 entries use the \`builtin:service-detection.*\` ids; v2 entries use \`builtin:service-detection-rules\` / \`builtin:url-path-pattern-matching-rules\` / \`builtin:service-splitting-rules\` / \`builtin:endpoint-detection-rules\` as appropriate.
- The matcher type chosen must match the service's URL pattern shape — call out trailing-slash, case-sensitivity, query-string-vs-path, and URL-encoding pitfalls in the entry's "verification" step.
- No CONTAINS-only rules. If proposed, must also have at least one anchored condition.
- No regex without capture group unless alternation is genuinely needed — flip to glob or BEGINS_WITH if so.
- A "rename" recommendation with a \`{placeholder}\` substitution must verify the placeholder source exists in the rule's available context (e.g. you can't substitute \`{H:X-Tenant-Id}\` if no header named X-Tenant-Id is on inbound traffic).

=== SUGGESTED RUM STRATEGY (mandatory) ===

Produce a forward-looking RUM strategy from Phase 4.8 findings. Per-app, prioritized by sessionCount desc.

Two artifacts:

1) "Suggested RUM Strategy" section in \`${reportDir}/report.md\` covering:
   - **Per-app feature plan** — table with one row per APPLICATION / MOBILE_APPLICATION / CUSTOM_APPLICATION:
     - \`appId\`, \`appName\`, \`appType\`, \`sessionCount\` (from inventory)
     - \`features_to_enable\` — list pulled from feature-matrix's "missing" entries, ranked by impact (Session Replay > KUAs > User-Action Naming > Apdex > Privacy > AD override > exclusions > resource cleanup)
     - \`features_to_tune\` — explicitly-configured features whose values look wrong (capture rate too high vs cost, apdex thresholds default vs observed p50/p95)
     - \`features_to_disable\` — features enabled but not used / not justified (Session Replay on a low-traffic app where it just costs)
     - per-feature evidence cite (raw artifact + objectId)
     - backlog REM ids
   - **Capture-rate plan** — for each app with high capture × high traffic, propose a sampling rate. Justify with observed sessionCount and target cost reduction.
   - **Apdex tuning plan** — for each app where apdex is using defaults, derive proposed thresholds from observed \`builtin:apps.web.userActionDuration.load\` p50/p95 (use upstream metrics query). Cite the percentile values.
   - **User-action naming plan** — for top apps by user-action cardinality, propose naming rules with the URL path matcher choice (per the matcher decision rules).
   - **KUA selection plan** — for each app with no KUAs, recommend up to 3 candidate KUAs from the top user actions by traffic. Justify the selection.
   - **Session Replay decision matrix** — per app: enable / disable / mask-more / keep-as-is. Driven by traffic, license, and presence of privacy preferences.
   - **Privacy plan** — for every app with Session Replay or User Tagging configured but no privacy preferences object, this is a HIGH severity entry: enable masking before next replay capture.
   - **Synthetic linkage plan** — high-traffic apps without an assigned synthetic monitor → recommend adding one; synthetic monitors assigned to dead apps → recommend removal.
   - **Implementation waves** — match the other strategies' wave concept. Wave 0 if any change requires metadata-enrichment to be on first.

2) \`${reportDir}/rum-strategy.json\` — machine-readable form. Each per-app entry is shaped so the write MCP can consume it directly: each \`feature_to_enable\` becomes a \`dt_create_settings\` payload referencing the right RUM schema with scope = applicationId.

Discipline:
- Every per-app feature recommendation must reference the matrix entry that justified it (\`evidence: { tool: 'dt_get_rum_app_feature_matrix', appId, feature, status }\`).
- Every payload field shaped against \`dt_get_schema(schemaId)\` before going to the write MCP.
- Privacy gaps (Session Replay or User Tagging without privacy preferences) are HIGH severity by default — agent cannot downgrade without explicit human override note.
- Don't recommend enabling features the cluster doesn't license — if a feature returned only "n/a" or "missing" with no env-default and no per-app override across all apps, it may not be in the license. Note that and skip rather than recommend.

=== SUGGESTED AUTO-TAGGING STRATEGY PER ENTITY (mandatory) ===

Produce a forward-looking auto-tag rule strategy derived from the tagging strategy above and the de-facto taxonomies discovered. The goal: each canonical tag key has exactly one auto-tag rule producing it per entity type, scoped correctly, keyed on stable signals.

Two artifacts:

1) "Suggested Auto-Tagging Strategy" section in \`${reportDir}/report.md\` covering, **per entity type** (HOST, PROCESS_GROUP, PROCESS_GROUP_INSTANCE, SERVICE):
   - **Per-entity-type rule table**. Columns:
     - \`tag key\` (one of the canonical keys from the tagging strategy)
     - \`tag value source\` — the property/expression that produces the value (e.g. \`{HostGroup:Name}\`, \`{ProcessGroup:DetectedName}\`, env var lookup, k8s label lookup)
     - \`condition\` — the entity selector the rule applies to (e.g. "host group name matches /^prod-/", "process tech includes JAVA")
     - \`expected coverage\` — what % of entities of this type the rule should cover, with evidence (e.g. "should hit 132 of 132 PGIs because OWNING_TEAM env var is set on all per phase2-pgis-all.json")
     - \`replaces existing rule\` — if there's a current rule that this one supersedes, list the existing object id so the backlog includes a delete/update step
     - \`backlog REM ids\`
     - \`evidence\`
   - **Rule consolidation findings** — current rules that fragment or duplicate the same key across entity types; recommendation is to consolidate into one canonical rule per (key, entity-type) pair.
   - **Inheritance / propagation strategy** — when a key should be set on a parent entity and inherited (host group → host → PG → PGI → service), spell out the chain explicitly.
   - **Implementation waves** — match the tagging strategy waves so the rules ship in lockstep with the tag keys they produce.

2) \`${reportDir}/auto-tag-strategy.json\` — array of rule definitions, grouped by entity type. Schema-compatible with builtin:tags.auto-tagging so the write MCP can use entries directly as the \`value\` field of dt_create_settings calls.

Discipline:
- Every rule must produce a key that's in the canonical key set from the tagging strategy. If a current rule produces a key not in the canonical set, the strategy says "delete this rule" (with REM entry).
- Every rule's condition must rely on stable signals (env vars, host groups, k8s labels, host metadata). Rules keying on manual tags or cmdline are flagged for replacement.
- Per (key, entity-type), there must be exactly ONE rule in the strategy. If two rules both produce \`team\` on PGI, consolidate.
- The auto-tag strategy, the PG detection strategy, the service naming strategy, the tagging strategy, and the remediation backlog must all reference each other consistently — no orphan recommendations across artifacts.

=== WRITE-MCP HANDOFF (mandatory, last step) ===

Produce a machine-actionable backlog the dt-managed-write-mcp can consume directly. Two artifacts:

1) \`${reportDir}/remediation-backlog.json\` — array of remediation entries. Each entry MUST be self-contained:
\`\`\`json
{
  "id": "REM-001",
  "phase": 1,
  "severity": "High|Medium|Low",
  "title": "short imperative — e.g. 'Add ownership auto-tag rule for team Foo'",
  "rationale": "1–3 sentences why",
  "evidence": [
    {
      "claim": "team tag has 71% coverage with 4 distinct casings",
      "tool": "dt_list_tags_for_entity type(HOST) from=now-24h",
      "rawPath": "raw/phase1-tags-host.json",
      "excerpt": "{ key: 'team', context: 'CONTEXTLESS', count: 47 } ; { key: 'team', value: 'Foo' } / { value: 'foo' } / { value: 'FOO' } / { value: 'FOO_TEAM' }"
    },
    {
      "claim": "OWNING_TEAM env var present on 124 of 132 PGIs (94%)",
      "tool": "dt_get_process_properties on a sample of 10 PGIs",
      "rawPath": "raw/phase2-pgis-all.json",
      "excerpt": "envVars.OWNING_TEAM observed in categorized output for PROCESS_GROUP_INSTANCE-A1B2..., PROCESS_GROUP_INSTANCE-C3D4..."
    }
  ],
  "alternativesConsidered": [
    { "approach": "DT_TAGS env var", "verdict": "rejected because owners can't redeploy", "evidenceRef": "REM-001#1" },
    { "approach": "host group reassignment", "verdict": "rejected because the signal is per-process not per-host", "evidenceRef": "REM-001#2" }
  ],
  "stabilityRating": "stable|moderate|fragile",
  "blastRadius": "single entity | one team | env-wide",
  "writeAction": {
    "tool": "dt_validate_settings | dt_create_settings | dt_update_settings",
    "payload": {
      "objects": [
        {
          "schemaId": "builtin:tags.auto-tagging",
          "scope": "environment",
          "value": { "...exact field shape from dt_get_schema..." }
        }
      ]
    },
    "objectIdToUpdate": null,
    "dryRunFirst": true
  },
  "preflight": [
    "Run dt_validate_settings with the same payload before dt_create_settings.",
    "If validate fails, the payload field-shape is wrong — re-fetch dt_get_schema and reconstruct."
  ],
  "verification": [
    "After write, re-run dt_get_auto_tags filter the new objectId; confirm scope and value match.",
    "After 5 minutes, dt_list_tags_for_entity on a representative HOST with the new tag's selector — confirm the tag appears with the auto-tag context."
  ]
}
\`\`\`

Discipline:
- For every entry, the \`evidence\` array MUST be present and non-empty. Each evidence item cites a tool call, a raw artifact path, and an excerpt of the exact data that justified the recommendation. No entry without evidence is allowed in the JSON.
- For every entry, the writeAction.payload MUST be valid against the schemaId. Before writing the entry, the agent MUST have called \`dt_get_schema(schemaId)\` and shaped the value to match.
- Set \`tool\` to \`dt_create_settings\` for new objects, \`dt_update_settings\` (with \`objectIdToUpdate\`) for changes to existing ones, \`dt_validate_settings\` for entries that should ONLY be dry-run (e.g. risky payloads pending human review).
- Always set \`dryRunFirst: true\` unless the change is a trivial label tweak.
- Do NOT include free-text "user must do this in UI" entries here. Anything not API-actionable goes into a separate \`${reportDir}/manual-actions.md\`.

2) \`${reportDir}/apply.sh\` — a runnable shell script that the write MCP operator can use as a checklist. Each line is a comment + the tool call template, in priority order. Example shape:
\`\`\`bash
#!/usr/bin/env bash
# REM-001 (High) — Add ownership auto-tag rule for team Foo
# 1. Validate first:
#    Use MCP tool dt_validate_settings with the payload from remediation-backlog.json#REM-001
# 2. If validate is clean, apply:
#    Use MCP tool dt_create_settings with confirm:"yes" and the same payload
# 3. Verify:
#    Use MCP tool dt_get_auto_tags filtered by the new objectId
\`\`\`

This is intentionally not auto-executable — humans must drive the write MCP. The script is the runbook, the JSON is the payload source of truth.

Also produce \`${reportDir}/manual-actions.md\` for items the API can't fix (UI-only settings, things requiring deploy access, things needing a different token scope), so the JSON backlog stays purely API-actionable.

Finally update the report.md Executive Summary to include:
- Total backlog size + breakdown by severity
- "API-actionable" count (entries in remediation-backlog.json) vs "manual" count (entries in manual-actions.md)
- Top 5 by severity × blast radius

Start with Phase 0.`;
}

export function registerAhrPrompt(server: McpServer): void {
  server.registerPrompt(
    "ahr",
    {
      title: "Dynatrace Account Health Review",
      description:
        "Run a phased Account Health Review (Hosts, PGs, Management Zones). Discovers the de-facto tag taxonomy from live data — does not require a pre-declared taxonomy. Stops after each phase for review.",
      argsSchema: {
        accountAlias: z
          .string()
          .describe(
            "Short name for this tenant, used in the output path (e.g. 'acme-prod'). Avoid spaces."
          ),
        expectedKeys: z
          .string()
          .optional()
          .describe(
            "OPTIONAL: comma-separated tag keys that SHOULD exist on every host (e.g. 'env,project,component,team,tier'). Used as an overlay after de-facto discovery, never as the baseline. Leave empty to rely purely on discovery."
          ),
      },
    },
    async ({ accountAlias, expectedKeys }) => {
      const text = buildPromptText(accountAlias, expectedKeys ?? "");
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );
}

