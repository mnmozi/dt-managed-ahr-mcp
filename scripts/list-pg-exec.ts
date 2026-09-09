#!/usr/bin/env tsx
/**
 * List every process group with its process group instances and the exec
 * command each instance actually runs (EXE_PATH + COMMAND_LINE_ARGS from
 * the entity metadata, falling back to EXE_NAME / JAVA_JAR_FILE).
 *
 * Read-only: two paginated /api/v2/entities sweeps (PGs, then PGIs with
 * +properties). PGIs attach to their PG via the isInstanceOf relationship.
 *
 * Usage:
 *   DT_CLUSTER_URL=... DT_ENV_ID=... DT_TOKEN=... DT_TLS_VERIFY=0 \
 *   npm run list:pg-exec [-- <pg-name-filter>] [-- --json]
 *
 *   <pg-name-filter>  optional case-insensitive substring on the PG name
 *   --json            emit JSON instead of text
 *   --by-pattern      group by normalized exec pattern instead of by PG:
 *                     digit runs, hex hashes, ids, and pod-name suffixes are
 *                     masked (<n>/<id>) so replicas and same-shaped workloads
 *                     collapse into one row, sorted by instance count.
 */
import { loadConfig } from "../src/config.js";
import { DtClient } from "../src/dt-client.js";

interface RawEntity {
  entityId?: string;
  displayName?: string;
  properties?: { metadata?: Array<{ key?: string; value?: string }> };
  fromRelationships?: Record<string, Array<{ id?: string; type?: string }>>;
}

async function fetchAll(client: DtClient, entityType: string, fields: string): Promise<RawEntity[]> {
  const all: RawEntity[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const query: Record<string, string | number | undefined> = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector: `type(${entityType})`,
          fields,
          from: "now-24h",
          to: "now",
          pageSize: 500,
        };
    const resp = await client.get<{ entities?: RawEntity[]; nextPageKey?: string | null }>(
      "/api/v2/entities",
      { query }
    );
    if (resp.entities) all.push(...resp.entities);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < 100);
  return all;
}

function metaValue(e: RawEntity, key: string): string | undefined {
  return e.properties?.metadata?.find((m) => m.key === key)?.value;
}

/** PGI → parent PG id via the isInstanceOf relationship (any rel name, target type checked). */
function parentPgId(e: RawEntity): string | undefined {
  for (const targets of Object.values(e.fromRelationships ?? {})) {
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (t?.type === "PROCESS_GROUP" && t?.id) return t.id;
    }
  }
  return undefined;
}

function execCommand(e: RawEntity): string {
  const exePath = metaValue(e, "EXE_PATH");
  const exeName = metaValue(e, "EXE_NAME");
  const args = metaValue(e, "COMMAND_LINE_ARGS");
  const jar = metaValue(e, "JAVA_JAR_FILE");
  const exe = exePath ?? exeName;
  if (exe && args) return `${exe} ${args}`;
  if (exe) return exe;
  if (jar) return `(jar) ${jar}`;
  return "(no exec metadata)";
}

/**
 * Normalize an exec command into a grouping pattern. General masking rules
 * only (no per-technology cases): within each separator-delimited segment,
 * pure digit runs -> <n>, hex-ish hashes -> <id>, mixed alnum ids with >=2
 * digits -> <id>. Replicas and same-shaped workloads collapse together.
 */
function execPattern(exec: string): string {
  return exec
    .split(/\s+/)
    .map((token) =>
      token
        .split(/([/.:=,@-])/)
        .map((seg) => {
          if (/^[/.:=,@-]$/.test(seg)) return seg;
          if (/^\d+$/.test(seg)) return "<n>";
          if (/^[0-9a-f]+$/i.test(seg) && /\d/.test(seg) && seg.length >= 4) return "<id>";
          const digits = (seg.match(/\d/g) ?? []).length;
          if (digits >= 2 && /[a-z]/i.test(seg) && seg.length >= 5) return "<id>";
          return seg;
        })
        .join("")
    )
    .join(" ");
}

interface PatternRow {
  pattern: string;
  instanceCount: number;
  processGroups: Map<string, number>;
  exampleExec: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const byPattern = args.includes("--by-pattern");
  const filter = args.find((a) => !a.startsWith("--"))?.toLowerCase();

  const client = new DtClient(loadConfig());
  const [pgs, pgis] = await Promise.all([
    fetchAll(client, "PROCESS_GROUP", "+fromRelationships"),
    fetchAll(client, "PROCESS_GROUP_INSTANCE", "+properties,+fromRelationships"),
  ]);

  const pgById = new Map<string, RawEntity>();
  for (const pg of pgs) if (pg.entityId) pgById.set(pg.entityId, pg);

  const instancesByPg = new Map<string, RawEntity[]>();
  const orphans: RawEntity[] = [];
  for (const pgi of pgis) {
    const pgId = parentPgId(pgi);
    if (pgId) {
      const list = instancesByPg.get(pgId) ?? [];
      list.push(pgi);
      instancesByPg.set(pgId, list);
    } else {
      orphans.push(pgi);
    }
  }

  const rows = [...pgById.values()]
    .filter((pg) => !filter || (pg.displayName ?? "").toLowerCase().includes(filter))
    .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""))
    .map((pg) => ({
      processGroup: pg.displayName ?? "(unnamed)",
      pgId: pg.entityId!,
      instances: (instancesByPg.get(pg.entityId!) ?? []).map((pgi) => ({
        name: pgi.displayName ?? "(unnamed)",
        pgiId: pgi.entityId,
        exec: execCommand(pgi),
      })),
    }));

  if (byPattern) {
    const byPat = new Map<string, PatternRow>();
    for (const pg of rows) {
      for (const inst of pg.instances) {
        const pattern = execPattern(inst.exec);
        const row = byPat.get(pattern) ?? {
          pattern,
          instanceCount: 0,
          processGroups: new Map<string, number>(),
          exampleExec: inst.exec,
        };
        row.instanceCount++;
        row.processGroups.set(pg.processGroup, (row.processGroups.get(pg.processGroup) ?? 0) + 1);
        byPat.set(pattern, row);
      }
    }
    const patRows = [...byPat.values()].sort(
      (a, b) => b.instanceCount - a.instanceCount || a.pattern.localeCompare(b.pattern)
    );
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            patterns: patRows.map((r) => ({
              pattern: r.pattern,
              instances: r.instanceCount,
              processGroups: Object.fromEntries(r.processGroups),
              exampleExec: r.exampleExec,
            })),
            orphanInstances: orphans.length,
          },
          null,
          2
        )
      );
      return;
    }
    for (const r of patRows) {
      console.log(`\n[${r.instanceCount} instance${r.instanceCount === 1 ? "" : "s"} / ${r.processGroups.size} PG${r.processGroups.size === 1 ? "" : "s"}]  ${r.pattern}`);
      for (const [pgName, count] of [...r.processGroups.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${pgName} (${count})`);
      }
      if (r.exampleExec !== r.pattern) console.log(`    e.g. ${r.exampleExec}`);
    }
    console.log(
      `\n${patRows.length} distinct exec patterns across ${rows.length} process groups` +
        (filter ? ` (filter: "${filter}")` : "")
    );
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({ processGroups: rows, orphanInstances: orphans.length }, null, 2));
    return;
  }

  for (const pg of rows) {
    console.log(`\n${pg.processGroup}  [${pg.pgId}]`);
    if (pg.instances.length === 0) {
      console.log("    (no instances seen in the last 24h)");
      continue;
    }
    for (const inst of pg.instances) {
      console.log(`    ${inst.name}  [${inst.pgiId}]`);
      console.log(`        exec: ${inst.exec}`);
    }
  }
  console.log(
    `\n${rows.length} process groups, ${pgis.length} instances` +
      (orphans.length ? `, ${orphans.length} instances without a resolvable PG` : "") +
      (filter ? ` (filter: "${filter}")` : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
