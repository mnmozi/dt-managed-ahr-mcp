/**
 * Shared helper: fetch hosts + PGs + PGIs + services with tags + properties +
 * relationships, then reshape into the engine's flat tag-graph input.
 *
 * The three tag-MCP tools (snapshot, signal-extraction, strategy-coverage)
 * all need the same fetch. This helper does it once.
 *
 * Tolerant of relationship-name variation across Managed versions — we don't
 * hardcode the exact field names (`runsOn` vs `runs_on`). Instead we scan
 * fromRelationships/toRelationships for entries whose target type matches
 * what we need.
 */
import type { DtClient } from "../dt-client.js";

export interface TagGraphInput {
  hosts: GraphHost[];
  processGroups: GraphPG[];
  processGroupInstances: GraphPGI[];
  services: GraphService[];
}

export interface GraphHost {
  id: string;
  displayName?: string;
  tags?: TagOccurrence[];
  properties?: Record<string, unknown>;
}

export interface GraphPG {
  id: string;
  displayName?: string;
  tags?: TagOccurrence[];
  properties?: Record<string, unknown>;
  hostId?: string;
}

export interface GraphPGI {
  id: string;
  displayName?: string;
  tags?: TagOccurrence[];
  properties?: Record<string, unknown>;
  hostId?: string;
  pgId?: string;
  serviceIds?: string[];
  callsPgiIds?: string[];
}

export interface GraphService {
  id: string;
  displayName?: string;
  tags?: TagOccurrence[];
  properties?: Record<string, unknown>;
  pgiIds?: string[];
  callsServiceIds?: string[];
  calledByServiceIds?: string[];
  /**
   * Display names of the service's SERVICE_METHOD entities (endpoints) —
   * e.g. "GET /api/v1/orders". Left undefined by fetchTagGraph; populated
   * by fetchNamingGraph (the naming pipeline needs it, the tag pipeline
   * doesn't). Optional so the tag tools are unaffected.
   */
  endpoints?: string[];
}

export interface TagOccurrence {
  context?: string;
  key: string;
  value?: string;
  stringRepresentation?: string;
}

interface RawEntity {
  entityId: string;
  displayName?: string;
  tags?: TagOccurrence[];
  properties?: Record<string, unknown>;
  fromRelationships?: Record<string, RawRelTarget[]>;
  toRelationships?: Record<string, RawRelTarget[]>;
}

interface RawRelTarget {
  id: string;
  type?: string;
}

/** Auto-paginate /api/v2/entities for one selector + field projection. */
async function fetchAllEntities(
  client: DtClient,
  entitySelector: string,
  fields: string
): Promise<RawEntity[]> {
  const all: RawEntity[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  const cap = 50;
  do {
    const query: Record<string, string | number | boolean | undefined> = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector,
          fields,
          from: "now-24h",
          to: "now",
          pageSize: 1000,
        };
    const resp = await client.get<{ entities?: RawEntity[]; nextPageKey?: string | null }>(
      "/api/v2/entities",
      { query }
    );
    if (resp.entities) all.push(...resp.entities);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < cap);
  return all;
}

/** Extract ids of related entities of a given type, scanning all relationship
 *  names (tolerant of `runsOn` vs `runs_on` variants). */
function relatedIdsOfType(rels: Record<string, RawRelTarget[]> | undefined, type: string): string[] {
  if (!rels) return [];
  const out: string[] = [];
  for (const targets of Object.values(rels)) {
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (t?.type === type && t?.id) out.push(t.id);
    }
  }
  // Dedupe
  return Array.from(new Set(out));
}

/** Pick first id of a related entity of a given type. */
function firstRelatedIdOfType(
  rels: Record<string, RawRelTarget[]> | undefined,
  type: string
): string | undefined {
  if (!rels) return undefined;
  for (const targets of Object.values(rels)) {
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (t?.type === type && t?.id) return t.id;
    }
  }
  return undefined;
}

/** Main entry point — fetch + reshape. */
export async function fetchTagGraph(client: DtClient): Promise<TagGraphInput> {
  // 4 parallel pagination passes. The fields projection asks for tags +
  // properties + relationship data. Field syntax varies slightly across
  // Managed versions but `+tags,+properties,+fromRelationships,+toRelationships`
  // is broadly supported.
  const [rawHosts, rawPGs, rawPGIs, rawServices] = await Promise.all([
    fetchAllEntities(client, "type(HOST)", "+tags,+properties"),
    fetchAllEntities(client, "type(PROCESS_GROUP)", "+tags,+properties,+fromRelationships,+toRelationships"),
    fetchAllEntities(client, "type(PROCESS_GROUP_INSTANCE)", "+tags,+properties,+fromRelationships,+toRelationships"),
    fetchAllEntities(client, "type(SERVICE)", "+tags,+properties,+fromRelationships,+toRelationships"),
  ]);

  const hosts: GraphHost[] = rawHosts.map((e) => ({
    id: e.entityId,
    displayName: e.displayName,
    tags: e.tags,
    properties: e.properties,
  }));

  const processGroups: GraphPG[] = rawPGs.map((e) => ({
    id: e.entityId,
    displayName: e.displayName,
    tags: e.tags,
    properties: e.properties,
    hostId: firstRelatedIdOfType(e.fromRelationships, "HOST"),
  }));

  const processGroupInstances: GraphPGI[] = rawPGIs.map((e) => ({
    id: e.entityId,
    displayName: e.displayName,
    tags: e.tags,
    properties: e.properties,
    hostId: firstRelatedIdOfType(e.fromRelationships, "HOST"),
    pgId: firstRelatedIdOfType(e.fromRelationships, "PROCESS_GROUP"),
    // Services THIS PGI backs come from toRelationships pointing to SERVICE
    serviceIds: relatedIdsOfType(e.toRelationships, "SERVICE"),
    // PGI → PGI call edges (when surfaced)
    callsPgiIds: relatedIdsOfType(e.fromRelationships, "PROCESS_GROUP_INSTANCE"),
  }));

  const services: GraphService[] = rawServices.map((e) => ({
    id: e.entityId,
    displayName: e.displayName,
    tags: e.tags,
    properties: e.properties,
    pgiIds: relatedIdsOfType(e.fromRelationships, "PROCESS_GROUP_INSTANCE"),
    callsServiceIds: relatedIdsOfType(e.fromRelationships, "SERVICE"),
    calledByServiceIds: relatedIdsOfType(e.toRelationships, "SERVICE"),
  }));

  return { hosts, processGroups, processGroupInstances, services };
}

/** Fetch the cluster's auto-tag rules (Settings 2.0 builtin:tags.auto-tagging). */
export async function fetchAutoTagRules(client: DtClient): Promise<Array<{ objectId: string; value: { name: string } }>> {
  const out: Array<{ objectId: string; value: { name: string } }> = [];
  let nextPageKey: string | null | undefined;
  do {
    const query: Record<string, string | number | boolean | undefined> = nextPageKey
      ? { nextPageKey }
      : { schemaIds: "builtin:tags.auto-tagging", pageSize: 500 };
    const resp = await client.get<{
      items?: Array<{ objectId: string; value: { name: string } }>;
      nextPageKey?: string | null;
    }>("/api/v2/settings/objects", { query });
    if (resp.items) out.push(...resp.items.map((i) => ({ objectId: i.objectId, value: i.value })));
    nextPageKey = resp.nextPageKey ?? null;
  } while (nextPageKey);
  return out;
}

/** Fetch ownership team names from builtin:ownership.teams. Tolerant: returns
 *  empty list when the schema isn't on this cluster. */
export async function fetchOwnershipTeams(client: DtClient): Promise<string[]> {
  try {
    let nextPageKey: string | null | undefined;
    const teams: string[] = [];
    do {
      const query: Record<string, string | number | boolean | undefined> = nextPageKey
        ? { nextPageKey }
        : { schemaIds: "builtin:ownership.teams", pageSize: 500 };
      const resp = await client.get<{
        items?: Array<{ value?: { name?: string; identifier?: string } }>;
        nextPageKey?: string | null;
      }>("/api/v2/settings/objects", { query });
      for (const it of resp.items ?? []) {
        const name = it.value?.identifier ?? it.value?.name;
        if (name) teams.push(name);
      }
      nextPageKey = resp.nextPageKey ?? null;
    } while (nextPageKey);
    return teams;
  } catch {
    return [];
  }
}
