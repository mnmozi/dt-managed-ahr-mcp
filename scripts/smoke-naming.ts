#!/usr/bin/env tsx
/**
 * Naming-pipeline smoke test against a real cluster. Read-only — never
 * writes. Runs the three audit analyzers end-to-end through the engine
 * subprocess and prints a compact per-bucket summary so you can verify
 * the pipeline works on YOUR cluster before opening the MCP transport.
 *
 * Usage:
 *   DT_CLUSTER_URL=... \
 *   DT_ENV_ID=... \
 *   DT_TOKEN_FILE=... \
 *   DT_ENGINE_BIN=/abs/path/to/dt-engine \
 *   DT_TLS_VERIFY=0 \
 *   npm run smoke:naming
 *
 * Add DT_LOG_LEVEL=debug to see every HTTP call + engine log line.
 *
 * What it does:
 *   1. Verify cluster connectivity (whoami-style)
 *   2. Start the engine subprocess
 *   3. Run dt_audit_process_group_naming → print counts + first 5 reports
 *   4. Run dt_audit_host_naming → print counts + first 5 reports
 *   5. Run dt_audit_host_groups → print counts + first 3 entries per category
 *   6. Stop the engine, exit
 *
 * Output is human-friendly. For machine-readable JSON, set
 * DT_NAMING_SMOKE_JSON=1 — the script then prints the raw analyzer
 * payloads (large) instead of summaries.
 */

import { loadConfig } from "../src/config.js";
import { DtClient, DtApiError } from "../src/dt-client.js";
import { getEngine, stopEngine } from "../src/engine/engine-singleton.js";
import { fetchNamingGraph } from "../src/engine/naming-graph-fetcher.js";
import { analyzeProcessGroupNaming, type ProcessGroupNamingAuditOutput, type EntityNamingReport } from "../src/engine/analyzers/processgroups-naming-audit.js";
import { analyzeHostNaming, type HostNamingAuditOutput } from "../src/engine/analyzers/hosts-naming-audit.js";
import { analyzeHostGroupsCoverage, type HostGroupsCoverageAuditOutput } from "../src/engine/analyzers/hostgroups-coverage-audit.js";

const JSON_MODE = process.env.DT_NAMING_SMOKE_JSON === "1";

function section(title: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(`  ${title}`);
  console.log("=".repeat(72));
}

function printPgSummary(out: ProcessGroupNamingAuditOutput): void {
  console.log(`Total PGs scanned:    ${out.counts.totalProcessGroups}`);
  console.log(`Generic-named flagged: ${out.counts.generic}`);
  console.log(`  high_confidence:     ${out.counts.highConfidence}`);
  console.log(`  ambiguous:           ${out.counts.ambiguous}`);
  console.log(`  no_signal:           ${out.counts.noSignal}`);
  if (out.reports.length === 0) {
    console.log("\n(no generic-named PGs — cluster is healthy on this axis)");
    return;
  }
  console.log("\nFirst few reports:");
  for (const r of out.reports.slice(0, 5)) {
    printReport(r);
  }
}

function printHostSummary(out: HostNamingAuditOutput): void {
  console.log(`Total hosts scanned:   ${out.counts.totalHosts}`);
  console.log(`Generic-named flagged: ${out.counts.generic}`);
  console.log(`  high_confidence:     ${out.counts.highConfidence}`);
  console.log(`  ambiguous:           ${out.counts.ambiguous}`);
  console.log(`  no_signal:           ${out.counts.noSignal}`);
  if (out.reports.length === 0) {
    console.log("\n(no generic-named hosts — cluster is healthy on this axis)");
    return;
  }
  console.log("\nFirst few reports:");
  for (const r of out.reports.slice(0, 5)) {
    printReport(r);
  }
}

function printReport(r: EntityNamingReport): void {
  console.log(`\n  ${r.entityType} ${r.entityId}`);
  console.log(`    currentName:   "${r.currentName}"`);
  console.log(`    genericReason: ${r.genericReason}`);
  console.log(`    decision:      ${r.decision}`);
  if (r.topCandidate) console.log(`    topCandidate:  "${r.topCandidate}"`);
  for (const c of r.candidates.slice(0, 4)) {
    console.log(`      - ${c.source} → "${c.name}" (${c.confidence.toFixed(2)})  // ${c.evidence}`);
  }
  if (r.candidates.length > 4) {
    console.log(`      …and ${r.candidates.length - 4} more candidate(s)`);
  }
}

function printHgSummary(out: HostGroupsCoverageAuditOutput): void {
  console.log(`Total hosts:          ${out.counts.totalHosts}`);
  console.log(`Total host groups:    ${out.counts.totalHostGroups}`);
  console.log(`Findings by category:`);
  console.log(`  hostsWithoutGroup:       ${out.counts.hostsWithoutGroup}`);
  console.log(`  splitFleets:             ${out.counts.splitFleets}`);
  console.log(`  singleMemberLikelyTypos: ${out.counts.singleMemberLikelyTypos}`);
  console.log(`  genericGroupNames:       ${out.counts.genericGroupNames}`);
  console.log(`  namingDriftClusters:     ${out.counts.namingDriftClusters}`);

  if (out.hostsWithoutGroup.length > 0) {
    console.log(`\nhostsWithoutGroup (first 3):`);
    for (const h of out.hostsWithoutGroup.slice(0, 3)) {
      console.log(`  - ${h.hostId} "${h.displayName ?? ""}"`);
      if (h.fleetSuggestion) console.log(`    → suggested group: "${h.fleetSuggestion}" (${h.evidence})`);
    }
  }
  if (out.splitFleets.length > 0) {
    console.log(`\nsplitFleets (first 3):`);
    for (const f of out.splitFleets.slice(0, 3)) {
      console.log(`  fleetKey=${f.fleetKey} memberCount=${f.memberCount}`);
      console.log(`    distribution: ${JSON.stringify(f.currentDistribution)}`);
      console.log(`    suggested:    "${f.suggestedGroup ?? "<none>"}"`);
      console.log(`    hostsToReassign: ${f.hostsToReassign.length}`);
    }
  }
  if (out.singleMemberLikelyTypos.length > 0) {
    console.log(`\nsingleMemberLikelyTypos (first 3):`);
    for (const t of out.singleMemberLikelyTypos.slice(0, 3)) {
      console.log(`  "${t.groupName}" → likely a typo of "${t.nearestPopulatedGroup}" (${t.nearestMemberCount} members, edit-dist ${t.editDistance})`);
    }
  }
  if (out.genericGroupNames.length > 0) {
    console.log(`\ngenericGroupNames (first 3):`);
    for (const g of out.genericGroupNames.slice(0, 3)) {
      console.log(`  "${g.groupName}" (${g.memberCount} members) — ${g.reason}`);
    }
  }
  if (out.namingDrift.length > 0) {
    console.log(`\nnamingDrift (first 3):`);
    for (const d of out.namingDrift.slice(0, 3)) {
      console.log(`  normalized="${d.normalized}" variants=${JSON.stringify(d.variants)} totalMembers=${d.totalMembers}`);
    }
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const client = new DtClient(cfg);

  // ----- step 1: connectivity check -----
  section("Step 1 — cluster connectivity");
  console.log(`Cluster: ${cfg.clusterUrl}`);
  console.log(`EnvId:   ${cfg.envId}`);
  console.log(`TLS:     ${cfg.tlsVerify ? "verify" : "SKIP (self-signed ok)"}`);
  console.log(`Engine:  ${process.env.DT_ENGINE_BIN ?? "dt-engine (PATH lookup)"}`);
  try {
    await client.get<{ totalCount?: number }>("/api/v2/settings/schemas", {
      query: { pageSize: 1 },
    });
    console.log("→ OK — cluster reachable + token valid");
  } catch (err) {
    if (err instanceof DtApiError) {
      console.error(`→ FAIL: HTTP ${err.status} on ${err.path}`);
      console.error(`   body: ${err.body.slice(0, 400)}`);
      if (err.status === 401) console.error("   hint: token invalid / wrong env id");
      if (err.status === 403) console.error("   hint: token missing ReadConfig scope");
    } else {
      console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
    await client.close();
    process.exit(1);
  }

  // ----- step 2: engine bootstrap -----
  section("Step 2 — engine subprocess");
  let engine;
  try {
    engine = await getEngine();
    console.log("→ OK — engine subprocess started");
  } catch (err) {
    console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "   hint: set DT_ENGINE_BIN to the absolute path of the dt-engine binary"
    );
    console.error("   build: cd ../dt-managed-engine && go build -o /tmp/dt-engine ./cmd/dt-engine");
    await client.close();
    process.exit(1);
  }

  // ----- step 3: fetch the entity graph ONCE (all three analyzers reuse it) -----
  section("Step 3 — fetch entity graph (hosts + PGs + PGIs + services)");
  const fetchStart = Date.now();
  let graph;
  try {
    graph = await fetchNamingGraph(client);
    const fetchMs = Date.now() - fetchStart;
    console.log(`→ OK — fetched in ${fetchMs}ms:`);
    console.log(`     hosts: ${graph.hosts.length}`);
    console.log(`     processGroups: ${graph.processGroups.length}`);
    console.log(`     processGroupInstances: ${graph.processGroupInstances.length}`);
    console.log(`     services: ${graph.services.length}`);
  } catch (err) {
    console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    await stopEngine();
    await client.close();
    process.exit(1);
  }

  // ----- step 4: PG naming audit -----
  section("Step 4 — dt_audit_process_group_naming");
  try {
    const t0 = Date.now();
    const out = await analyzeProcessGroupNaming(engine, { ...graph });
    console.log(`(analyzer ran in ${Date.now() - t0}ms)\n`);
    if (JSON_MODE) console.log(JSON.stringify(out, null, 2));
    else printPgSummary(out);
  } catch (err) {
    console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ----- step 5: host naming audit -----
  section("Step 5 — dt_audit_host_naming");
  try {
    const t0 = Date.now();
    const out = await analyzeHostNaming(engine, { ...graph });
    console.log(`(analyzer ran in ${Date.now() - t0}ms)\n`);
    if (JSON_MODE) console.log(JSON.stringify(out, null, 2));
    else printHostSummary(out);
  } catch (err) {
    console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ----- step 6: host-group coverage audit -----
  section("Step 6 — dt_audit_host_groups");
  try {
    const t0 = Date.now();
    const out = await analyzeHostGroupsCoverage(engine, { ...graph });
    console.log(`(analyzer ran in ${Date.now() - t0}ms)\n`);
    if (JSON_MODE) console.log(JSON.stringify(out, null, 2));
    else printHgSummary(out);
  } catch (err) {
    console.error(`→ FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ----- shutdown -----
  await stopEngine();
  await client.close();

  section(`Done — total ${Date.now() - startedAt}ms`);
  console.log("Read-only smoke test complete.");
  console.log("");
  console.log("Next steps:");
  console.log("  - Review the reports above. Do the high_confidence candidates");
  console.log("    look right? Do any 'ambiguous' bucket entries surprise you?");
  console.log("  - To exercise the write path on a SINGLE entity, run:");
  console.log("    DT_NAMING_SMOKE_JSON=1 npm run smoke:naming > /tmp/naming-audit.json");
  console.log("    Then hand-craft a dt_apply_pg_naming_rule / dt_apply_host_clarifying_tag");
  console.log("    call from MCP with one decision + confirm:'yes'.");
}

main().catch((err) => {
  console.error(`\n[smoke-naming] unexpected error: ${err instanceof Error ? err.stack : err}`);
  void stopEngine().catch(() => undefined);
  process.exit(1);
});
