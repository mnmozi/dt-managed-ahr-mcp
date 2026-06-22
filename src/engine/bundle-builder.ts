import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DtClient } from "../dt-client.js";
import { DtApiError } from "../dt-client.js";

/**
 * Bundle materializer.
 *
 * Each engine check needs specific JSON files in <bundle>/raw/. We model this
 * as a registry: per-check → list of files it needs → how to fetch each.
 *
 * Given a set of requested check IDs, the builder:
 *   1. Dedupes required files across them
 *   2. Calls the right Dynatrace endpoint for each
 *   3. Writes the JSON to <bundle>/raw/<filename>
 *   4. Returns the bundle path so the engine can read it
 *
 * Files that fail to fetch are skipped — the engine's bundle.Load() tolerates
 * missing files. The builder reports per-file success/failure in its result.
 */

/** Definition of one raw file the engine consumes. */
interface RawFile {
  /** Filename under <bundle>/raw/. */
  name: string;
  /** Function that calls the cluster and returns the JSON to write. */
  fetch: (client: DtClient) => Promise<unknown>;
}

const TAG_ENTITY_TYPES: Array<{ tagFile: string; selector: string }> = [
  { tagFile: "phase1-tags-host.json", selector: "type(HOST)" },
  { tagFile: "phase1-tags-service.json", selector: "type(SERVICE)" },
  { tagFile: "phase2-tags-process_group.json", selector: "type(PROCESS_GROUP)" },
  { tagFile: "phase2-tags-process_group_instance.json", selector: "type(PROCESS_GROUP_INSTANCE)" },
];

/** All known raw files keyed by filename. */
const RAW_FILES: Record<string, RawFile> = {
  "phase1-auto-tags.json": {
    name: "phase1-auto-tags.json",
    fetch: (c) =>
      fetchAllSettingsObjects(c, "builtin:tags.auto-tagging"),
  },
  "phase1-oneagents.json": {
    name: "phase1-oneagents.json",
    fetch: async (c) => {
      // /api/v2/oneagents — auto-paginate
      const all: unknown[] = [];
      let nextPageKey: string | undefined;
      do {
        const query: Record<string, string | number | undefined> = nextPageKey
          ? { nextPageKey }
          : { pageSize: 500 };
        const page = await c.get<{ hosts?: unknown[]; nextPageKey?: string | null }>(
          "/api/v2/oneagents",
          { query }
        );
        for (const h of page.hosts ?? []) all.push(h);
        nextPageKey = page.nextPageKey ?? undefined;
      } while (nextPageKey);
      return { hosts: all };
    },
  },
  "phase1-hosts-all.json": {
    name: "phase1-hosts-all.json",
    fetch: (c) => fetchAllEntities(c, "type(HOST)"),
  },
  "phase1-hostgroups-all.json": {
    name: "phase1-hostgroups-all.json",
    fetch: (c) => fetchAllEntities(c, "type(HOST_GROUP)"),
  },
  "phase2-pgs-all.json": {
    name: "phase2-pgs-all.json",
    fetch: (c) => fetchAllEntities(c, "type(PROCESS_GROUP)"),
  },
  "phase2-pgis-all.json": {
    name: "phase2-pgis-all.json",
    fetch: (c) => fetchAllEntities(c, "type(PROCESS_GROUP_INSTANCE)"),
  },
  "phase3-management-zones.json": {
    name: "phase3-management-zones.json",
    fetch: (c) =>
      fetchAllSettingsObjects(c, "builtin:management-zones"),
  },
  "phase4-services-all.json": {
    name: "phase4-services-all.json",
    fetch: (c) => fetchAllEntities(c, "type(SERVICE)"),
  },
  "phase46-api-tokens.json": {
    name: "phase46-api-tokens.json",
    fetch: async (c) => {
      const all: unknown[] = [];
      let nextPageKey: string | undefined;
      do {
        const query: Record<string, string | number | undefined> = nextPageKey
          ? { nextPageKey }
          : { pageSize: 500 };
        const page = await c.get<{ apiTokens?: unknown[]; nextPageKey?: string | null }>(
          "/api/v2/apiTokens",
          { query }
        );
        for (const t of page.apiTokens ?? []) all.push(t);
        nextPageKey = page.nextPageKey ?? undefined;
      } while (nextPageKey);
      return { apiTokens: all };
    },
  },
  // Tag occurrences — one file per entity type. These all use the same shape.
  ...Object.fromEntries(
    TAG_ENTITY_TYPES.map((t) => [
      t.tagFile,
      {
        name: t.tagFile,
        fetch: (c: DtClient) =>
          c.get("/api/v2/tags", {
            query: { entitySelector: t.selector, from: "now-24h", to: "now" },
          }),
      },
    ])
  ),
};

/**
 * Per-check required-files registry. Mirrors what each Go check reads.
 * The engine itself tolerates missing files (per bundle.go) — this map drives
 * which files we attempt to materialize. Be liberal: a check that *might*
 * use a file lists it; spurious fetches are cheap relative to the latency of
 * running the engine.
 */
export const CHECK_REQUIREMENTS: Record<string, string[]> = {
  CHECK_AUTO_TAG_DEAD: [
    "phase1-auto-tags.json",
    "phase1-tags-host.json",
    "phase1-tags-service.json",
    "phase2-tags-process_group.json",
    "phase2-tags-process_group_instance.json",
    "phase1-hosts-all.json",
    "phase4-services-all.json",
  ],
  CHECK_AUTO_TAG_OVERBROAD: [
    "phase1-auto-tags.json",
    "phase1-tags-host.json",
    "phase1-tags-service.json",
    "phase2-tags-process_group.json",
    "phase2-tags-process_group_instance.json",
  ],
  CHECK_HOST_NO_HOSTGROUP: ["phase1-hosts-all.json"],
  CHECK_HOSTGROUP_SINGLETON: ["phase1-hosts-all.json"],
  CHECK_FULLSTACK_NO_LOGS: ["phase1-oneagents.json"],
  CHECK_TAG_INCONSISTENT_ROLLOUT: [
    "phase1-tags-host.json",
    "phase1-tags-service.json",
    "phase2-tags-process_group.json",
    "phase2-tags-process_group_instance.json",
  ],
  CHECK_PG_PGIS_SPAN_ENVS: ["phase2-pgs-all.json", "phase2-pgis-all.json"],
  CHECK_MZ_DEAD: [
    "phase3-management-zones.json",
    "phase1-hosts-all.json",
    "phase4-services-all.json",
    "phase2-pgs-all.json",
  ],
  CHECK_MZ_OVERLAP: [
    "phase3-management-zones.json",
    "phase1-hosts-all.json",
    "phase4-services-all.json",
  ],
  CHECK_TOKEN_NEVER_USED: ["phase46-api-tokens.json"],
};

export interface BuildBundleResult {
  bundlePath: string;
  fetchedFiles: string[];
  failedFiles: Array<{ name: string; error: string }>;
  skippedFiles: string[]; // when reusing a pre-existing bundle
}

/**
 * Materialize a bundle on disk for the given check IDs.
 *
 * @param client      Live MCP HTTP client.
 * @param bundleRoot  Directory under which to write. Created if missing.
 * @param checkIds    Check IDs whose required files we should fetch. Empty = all known files.
 * @param skipExisting Skip fetch if the file already exists (useful when re-running).
 */
export async function buildBundle(
  client: DtClient,
  bundleRoot: string,
  checkIds: string[],
  skipExisting: boolean
): Promise<BuildBundleResult> {
  const rawDir = join(bundleRoot, "raw");
  mkdirSync(rawDir, { recursive: true });

  // Resolve which files we need
  const required = new Set<string>();
  if (checkIds.length === 0) {
    for (const f of Object.keys(RAW_FILES)) required.add(f);
  } else {
    for (const id of checkIds) {
      const files = CHECK_REQUIREMENTS[id];
      if (!files) continue; // unknown check — engine will surface that on call
      for (const f of files) required.add(f);
    }
  }

  const fetchedFiles: string[] = [];
  const failedFiles: Array<{ name: string; error: string }> = [];
  const skippedFiles: string[] = [];

  for (const name of required) {
    const def = RAW_FILES[name];
    if (!def) continue;

    const outPath = join(rawDir, name);
    if (skipExisting && existsSync(outPath)) {
      skippedFiles.push(name);
      continue;
    }
    try {
      const data = await def.fetch(client);
      writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
      fetchedFiles.push(name);
    } catch (err) {
      const msg =
        err instanceof DtApiError
          ? `HTTP ${err.status} ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : String(err);
      failedFiles.push({ name, error: msg });
    }
  }

  return { bundlePath: bundleRoot, fetchedFiles, failedFiles, skippedFiles };
}

// ---------- helpers ----------

async function fetchAllSettingsObjects(client: DtClient, schemaId: string): Promise<unknown> {
  const all: unknown[] = [];
  let nextPageKey: string | undefined;
  do {
    const query: Record<string, string | number | undefined> = nextPageKey
      ? { nextPageKey }
      : { schemaIds: schemaId, pageSize: 500 };
    const page = await client.get<{ items?: unknown[]; nextPageKey?: string | null }>(
      "/api/v2/settings/objects",
      { query }
    );
    for (const it of page.items ?? []) all.push(it);
    nextPageKey = page.nextPageKey ?? undefined;
  } while (nextPageKey);
  return { items: all };
}

async function fetchAllEntities(client: DtClient, entitySelector: string): Promise<unknown> {
  const all: unknown[] = [];
  let nextPageKey: string | undefined;
  do {
    const query: Record<string, string | number | undefined> = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector,
          from: "now-24h",
          to: "now",
          pageSize: 1000,
          fields: "+tags,+managementZones,+properties",
        };
    const page = await client.get<{ entities?: unknown[]; nextPageKey?: string | null }>(
      "/api/v2/entities",
      { query }
    );
    for (const e of page.entities ?? []) all.push(e);
    nextPageKey = page.nextPageKey ?? undefined;
  } while (nextPageKey);
  return { items: all };
}
