/**
 * Data fetcher for the naming analyzers (processgroups.naming_audit,
 * hosts.naming_audit, hostgroups.coverage_audit).
 *
 * Starts from the shared tag-graph fetch (hosts + PGs + PGIs + services
 * with properties + relationships), then adds ONE more pass the tag
 * pipeline doesn't need: SERVICE_METHOD entities, whose display names are
 * the service's endpoints ("GET /api/v1/orders", "OrdersController.list").
 * The PG naming analyzer's Phase-B endpoint-path heuristic derives a name
 * from those paths even when the service itself is generically named.
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

/** Cap on SERVICE_METHOD pagination — busy tenants can have thousands. */
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
 * Fetch SERVICE_METHOD entities, group their display names by parent
 * SERVICE id, and attach onto graph.services[].endpoints. Tolerant: any
 * failure leaves endpoints empty rather than aborting the whole audit.
 */
async function attachServiceEndpoints(
  client: DtClient,
  graph: NamingGraphInput
): Promise<void> {
  let methods: RawMethodEntity[];
  try {
    methods = await fetchAllServiceMethods(client);
  } catch (err) {
    log.warn("SERVICE_METHOD fetch failed; naming proceeds without endpoint signal", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Group endpoint display names by the SERVICE they belong to. The
  // SERVICE_METHOD → SERVICE relationship name varies across Managed
  // versions, so scan every relationship bucket for a SERVICE target.
  const byService = new Map<string, string[]>();
  for (const m of methods) {
    const name = (m.displayName ?? "").trim();
    if (!name) continue;
    const svcId =
      firstRelatedIdOfType(m.fromRelationships, "SERVICE") ??
      firstRelatedIdOfType(m.toRelationships, "SERVICE");
    if (!svcId) continue;
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
    servicesWithEndpoints: withEndpoints,
    totalServices: graph.services.length,
  });
}

/** Auto-paginate /api/v2/entities for type(SERVICE_METHOD). */
async function fetchAllServiceMethods(client: DtClient): Promise<RawMethodEntity[]> {
  const all: RawMethodEntity[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const query: Record<string, string | number | boolean | undefined> = nextPageKey
      ? { nextPageKey }
      : {
          entitySelector: "type(SERVICE_METHOD)",
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
