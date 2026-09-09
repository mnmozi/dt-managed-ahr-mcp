/**
 * Data fetcher for the naming analyzers (processgroups.naming_audit,
 * hosts.naming_audit, hostgroups.coverage_audit).
 *
 * Starts from the shared tag-graph fetch (hosts + PGs + PGIs + services
 * with properties + relationships), then adds the passes the tag pipeline
 * doesn't need: SERVICE_METHOD + SERVICE_METHOD_GROUP entities, whose
 * display names are the service's endpoints ("GET /api/v1/orders",
 * "/tariff/quote", "OrdersController.list"). The PG naming analyzer's
 * Phase-B endpoint-path heuristic derives a name from those paths even
 * when the service itself is generically named.
 *
 * The containment chain on live Managed (verified on 1.341) is TWO hops:
 *
 *   SERVICE_METHOD --isServiceMethodOf--> SERVICE_METHOD_GROUP --isGroupOf--> SERVICE
 *
 * Methods carry NO direct SERVICE relationship, so we fetch method groups
 * too and join through them. For robustness we still check the method's
 * own relationships for a direct SERVICE target first (other Managed
 * versions may flatten the chain).
 *
 * Endpoints are attached onto each GraphService.endpoints[]. If the
 * SERVICE_METHOD fetch fails (older Managed versions, permission gaps),
 * we log + continue with empty endpoints — naming still works off the
 * other signals.
 */
import type { DtClient } from "../dt-client.js";
import { fetchTagGraph, type TagGraphInput } from "./tag-graph-fetcher.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("naming-graph-fetcher");

/** Same shape as TagGraphInput — naming analyzers consume hosts + PGs + PGIs + services. */
export type NamingGraphInput = TagGraphInput;

/** Cap on per-type pagination — busy tenants can have thousands of methods. */
const MAX_METHOD_PAGES = 50;
/** Cap on endpoints kept per service — the heuristic only needs a sample. */
const MAX_ENDPOINTS_PER_SERVICE = 60;

interface RawMethodEntity {
  entityId: string;
  displayName?: string;
  fromRelationships?: Record<string, Array<{ id: string; type?: string }>>;
  toRelationships?: Record<string, Array<{ id: string; type?: string }>>;
}

export async function fetchNamingGraph(client: DtClient): Promise<NamingGraphInput> {
  const graph = await fetchTagGraph(client);
  await attachServiceEndpoints(client, graph);
  return graph;
}

/**
 * Fetch SERVICE_METHOD + SERVICE_METHOD_GROUP entities, join method →
 * group → service, and attach endpoint display names onto
 * graph.services[].endpoints. Tolerant: any failure leaves endpoints
 * empty rather than aborting the whole audit.
 */
async function attachServiceEndpoints(
  client: DtClient,
  graph: NamingGraphInput
): Promise<void> {
  let methods: RawMethodEntity[];
  let groups: RawMethodEntity[];
  try {
    [methods, groups] = await Promise.all([
      fetchAllEntitiesOfType(client, "SERVICE_METHOD"),
      fetchAllEntitiesOfType(client, "SERVICE_METHOD_GROUP"),
    ]);
  } catch (err) {
    log.warn("SERVICE_METHOD fetch failed; naming proceeds without endpoint signal", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Map method-group id → parent SERVICE id. Edge direction varies across
  // Managed versions, so scan both relationship maps.
  const serviceByGroup = new Map<string, string>();
  for (const g of groups) {
    const svcId =
      firstRelatedIdOfType(g.fromRelationships, "SERVICE") ??
      firstRelatedIdOfType(g.toRelationships, "SERVICE");
    if (svcId) serviceByGroup.set(g.entityId, svcId);
  }

  // Group endpoint display names by SERVICE: direct edge first (flattened
  // chains), else two-hop via the method group.
  const byService = new Map<string, string[]>();
  let unmapped = 0;
  for (const m of methods) {
    const name = (m.displayName ?? "").trim();
    if (!name) continue;
    let svcId =
      firstRelatedIdOfType(m.fromRelationships, "SERVICE") ??
      firstRelatedIdOfType(m.toRelationships, "SERVICE");
    if (!svcId) {
      const groupId =
        firstRelatedIdOfType(m.fromRelationships, "SERVICE_METHOD_GROUP") ??
        firstRelatedIdOfType(m.toRelationships, "SERVICE_METHOD_GROUP");
      if (groupId) svcId = serviceByGroup.get(groupId);
    }
    if (!svcId) {
      unmapped++;
      continue;
    }
    const list = byService.get(svcId) ?? [];
    if (list.length < MAX_ENDPOINTS_PER_SERVICE) list.push(name);
    byService.set(svcId, list);
  }

  let withEndpoints = 0;
  for (const svc of graph.services) {
    const eps = byService.get(svc.id);
    if (eps && eps.length > 0) {
      svc.endpoints = eps;
      withEndpoints++;
    }
  }
  log.info("attached service endpoints", {
    serviceMethods: methods.length,
    methodGroups: groups.length,
    unmappedMethods: unmapped,
    servicesWithEndpoints: withEndpoints,
    totalServices: graph.services.length,
  });
}

/** Auto-paginate /api/v2/entities for one entity type with relationships. */
async function fetchAllEntitiesOfType(
  client: DtClient,
  entityType: string
): Promise<RawMethodEntity[]> {
  const all: RawMethodEntity[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const query: Record<string, string | number | boolean | undefined> = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector: `type(${entityType})`,
          fields: "+fromRelationships,+toRelationships",
          from: "now-24h",
          to: "now",
          pageSize: 1000,
        };
    const resp = await client.get<{
      entities?: RawMethodEntity[];
      nextPageKey?: string | null;
    }>("/api/v2/entities", { query });
    if (resp.entities) all.push(...resp.entities);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < MAX_METHOD_PAGES);
  return all;
}

/** First related id of a given target type, scanning all relationship names. */
function firstRelatedIdOfType(
  rels: Record<string, Array<{ id: string; type?: string }>> | undefined,
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
