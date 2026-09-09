#!/usr/bin/env tsx
/**
 * Schema-drift check: diff every wrapper's probe list (and companion
 * endpoints) against the LIVE cluster. Run after every Managed upgrade —
 * this is what catches renames like builtin:network-zones →
 * builtin:networkzones before a wrapper silently goes dark.
 *
 * Usage:
 *   DT_CLUSTER_URL=... DT_ENV_ID=... DT_TOKEN=... DT_TLS_VERIFY=0 \
 *   npm run drift:schemas
 *
 * Exit codes: 0 = no fully-dead wrappers, 1 = at least one wrapper has
 * zero live schema ids AND zero live companion endpoints (it would return
 * SURFACE_MISSING at runtime), 2 = could not reach the cluster.
 *
 * Read-only: schema inventory via GET /api/v2/settings/schemas; companion
 * endpoints probed with plain GETs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { DtApiError, DtClient } from "../src/dt-client.js";
import { WRAPPERS } from "../src/register/reads-schema-wrappers.js";

/**
 * schema-baseline.json = last known inventory (schemaId -> latestSchemaVersion).
 * Ids tell you a wrapper went dark; VERSION bumps tell you a write payload
 * shape may have changed — both are reported. Pass --update-baseline to
 * rewrite it from the live cluster after reviewing the diff.
 */
const BASELINE_PATH = new URL("../schema-baseline.json", import.meta.url);

interface Baseline {
  clusterVersion?: string;
  capturedAt?: string;
  note?: string;
  schemas: Record<string, string>;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const client = new DtClient(cfg);

  let liveIds: Set<string>;
  const liveVersions = new Map<string, string>();
  try {
    const resp = await client.get<{
      items?: Array<{ schemaId?: string; latestSchemaVersion?: string }>;
    }>("/api/v2/settings/schemas");
    for (const s of resp.items ?? []) {
      if (s.schemaId) liveVersions.set(s.schemaId, s.latestSchemaVersion ?? "?");
    }
    liveIds = new Set(liveVersions.keys());
  } catch (err) {
    console.error(
      `FATAL: could not list settings schemas: ${err instanceof Error ? err.message : String(err)}`
    );
    return 2;
  }
  let clusterVersion = "unknown";
  try {
    const v = await client.get<{ version?: string }>("/api/v1/config/clusterversion");
    clusterVersion = v.version ?? clusterVersion;
  } catch {
    // informational only
  }
  console.log(`Cluster ${clusterVersion} — live schema inventory: ${liveIds.size} schemas\n`);

  // --- Baseline diff (ids + versions) -----------------------------------
  if (existsSync(BASELINE_PATH)) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    const added = [...liveIds].filter((id) => !(id in base.schemas)).sort();
    const removed = Object.keys(base.schemas).filter((id) => !liveIds.has(id)).sort();
    const bumped = Object.entries(base.schemas)
      .filter(([id, ver]) => liveIds.has(id) && liveVersions.get(id) !== ver)
      .map(([id, ver]) => `${id}: ${ver} -> ${liveVersions.get(id)}`)
      .sort();
    console.log(
      `Baseline: cluster ${base.clusterVersion ?? "?"} captured ${base.capturedAt ?? "?"} (${Object.keys(base.schemas).length} schemas)`
    );
    if (added.length === 0 && removed.length === 0 && bumped.length === 0) {
      console.log("  no drift vs baseline (same ids, same versions)\n");
    } else {
      if (added.length) console.log(`  ADDED (${added.length}):\n    ${added.join("\n    ")}`);
      if (removed.length)
        console.log(`  REMOVED (${removed.length}) — check every wrapper probing these:\n    ${removed.join("\n    ")}`);
      if (bumped.length)
        console.log(
          `  VERSION BUMPED (${bumped.length}) — re-validate write payloads against these:\n    ${bumped.join("\n    ")}`
        );
      console.log("");
    }
  } else {
    console.log("No schema-baseline.json yet — run with --update-baseline to create it.\n");
  }
  if (process.argv.includes("--update-baseline")) {
    const out: Baseline = {
      clusterVersion,
      capturedAt: new Date().toISOString().slice(0, 10),
      note: "Last known Settings 2.0 inventory (schemaId -> latestSchemaVersion). Updated by `npm run drift:schemas -- --update-baseline` after every Managed upgrade.",
      schemas: Object.fromEntries([...liveVersions.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`Baseline rewritten from cluster ${clusterVersion}.\n`);
  }

  const referenced = new Set<string>();
  let fullyDead = 0;

  for (const w of WRAPPERS) {
    const alive = w.schemaIds.filter((id) => liveIds.has(id));
    const dead = w.schemaIds.filter((id) => !liveIds.has(id));
    for (const id of w.schemaIds) referenced.add(id);

    const companionStates: string[] = [];
    let anyCompanionAlive = false;
    for (const ep of w.companionEndpoints ?? []) {
      try {
        await client.get<unknown>(ep.path);
        companionStates.push(`    live companion: ${ep.label} (${ep.path})`);
        anyCompanionAlive = true;
      } catch (err) {
        if (err instanceof DtApiError && err.status === 404 && ep.notFoundMeansUnsupported) {
          companionStates.push(`    unsupported-on-this-version: ${ep.label} (${ep.path})`);
        } else {
          const detail =
            err instanceof DtApiError ? `HTTP ${err.status}` : (err as Error).message;
          companionStates.push(`    DEAD companion: ${ep.label} (${ep.path}) — ${detail}`);
        }
      }
    }

    const isFullyDead = alive.length === 0 && !anyCompanionAlive;
    if (isFullyDead && !w.staticNote) fullyDead++;

    const verdict = isFullyDead
      ? w.staticNote
        ? "not available on this platform (documented via staticNote — expected, not a failure)"
        : "FULLY DEAD — would return SURFACE_MISSING"
      : alive.length === 0
        ? "config-v1-only (all schema probes dead, companion alive)"
        : dead.length > 0
          ? `ok (${alive.length} live, ${dead.length} dead probes — dead ones are fine as multi-version tolerance)`
          : "ok (all probes live)";
    // Phantom check: the objects endpoint sometimes answers 200 for ids the
    // cluster does not advertise (hidden schemas). The runtime wrapper
    // treats those as absent; surface them here so nobody "fixes" a probe
    // that is actually behaving correctly.
    const phantom: string[] = [];
    for (const id of dead) {
      try {
        await client.get<unknown>("/api/v2/settings/objects", {
          query: { schemaIds: id, pageSize: 1 },
        });
        phantom.push(id);
      } catch {
        // genuinely dead
      }
    }
    console.log(`${w.toolName}: ${verdict}`);
    if (dead.length > 0) console.log(`    dead probe ids: ${dead.join(", ")}`);
    if (phantom.length > 0)
      console.log(
        `    phantom (objects endpoint answers, schema NOT advertised — runtime treats as absent): ${phantom.join(", ")}`
      );
    for (const line of companionStates) console.log(line);
  }

  const uncovered = [...liveIds].filter((id) => !referenced.has(id)).sort();
  console.log(
    `\nLive schemas not referenced by any wrapper: ${uncovered.length} (raw access remains available via dt_list_settings_objects)`
  );
  for (const id of uncovered) console.log(`    ${id}`);

  if (fullyDead > 0) {
    console.error(
      `\n${fullyDead} wrapper(s) FULLY DEAD — add the renamed schema ids or a companion endpoint.`
    );
    return 1;
  }
  console.log("\nNo fully-dead wrappers.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  }
);
