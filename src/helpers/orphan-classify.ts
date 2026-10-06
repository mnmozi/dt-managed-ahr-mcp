/**
 * Pure classification for dt_get_entity_orphans.
 *
 * Relationship direction in the Dynatrace entity model is easy to get
 * backwards, and the two maps are complementary, not interchangeable:
 *
 *   SERVICE   fromRelationships.runsOnProcessGroupInstance → PGI
 *             toRelationships.calls / isCalledBy          → SERVICE
 *   PGI       fromRelationships.isInstanceOf              → PROCESS_GROUP
 *             fromRelationships.isProcessOf               → HOST
 *             toRelationships.runsOnProcessGroupInstance  → SERVICE
 *   HOST      toRelationships.isProcessOf                 → PGI
 *             toRelationships.runsOn                      → PROCESS_GROUP
 *
 * Relationship NAMES also vary across Managed versions, so — like the
 * tag-graph fetcher — we never key on a name: we scan every bucket of BOTH
 * maps and match on the target entity type.
 */

export type RelMap = Record<string, Array<{ id?: string; type?: string }>>;

export interface OrphanEntity {
  entityId?: string;
  displayName?: string;
  lastSeenTms?: number;
  fromRelationships?: RelMap;
  toRelationships?: RelMap;
}

export interface OrphanInput {
  services: OrphanEntity[];
  hosts: OrphanEntity[];
  processGroups: OrphanEntity[];
  processGroupInstances: OrphanEntity[];
  nowMs: number;
  inactiveAfterMs: number;
}

export interface OrphanOutput {
  orphanServices: OrphanEntity[];
  zombieProcessGroups: OrphanEntity[];
  hostsWithNoMonitoredPg: OrphanEntity[];
  inactiveHosts: OrphanEntity[];
}

/** Every related target across both relationship maps. */
export function relatedTargets(e: OrphanEntity): Array<{ id?: string; type?: string }> {
  const out: Array<{ id?: string; type?: string }> = [];
  for (const rel of [e.fromRelationships, e.toRelationships]) {
    if (!rel) continue;
    for (const targets of Object.values(rel)) {
      if (!Array.isArray(targets)) continue;
      for (const t of targets) if (t) out.push(t);
    }
  }
  return out;
}

function hasTargetOfType(e: OrphanEntity, ...types: string[]): boolean {
  return relatedTargets(e).some((t) => t.type !== undefined && types.includes(t.type));
}

export function classifyOrphans(input: OrphanInput): OrphanOutput {
  const { services, hosts, processGroups, processGroupInstances, nowMs, inactiveAfterMs } = input;

  // SERVICE with no backing PG / PGI on either side → broken detection.
  const orphanServices = services.filter(
    (s) => !hasTargetOfType(s, "PROCESS_GROUP", "PROCESS_GROUP_INSTANCE")
  );

  // PG whose instances are all gone. Count PGIs per PG from the PGI side
  // (isInstanceOf), and also accept a PGI link on the PG side — whichever
  // this Managed version surfaces.
  const pgisByPg = new Map<string, number>();
  for (const pgi of processGroupInstances) {
    for (const t of relatedTargets(pgi)) {
      if (t.type === "PROCESS_GROUP" && t.id) pgisByPg.set(t.id, (pgisByPg.get(t.id) ?? 0) + 1);
    }
  }
  const zombieProcessGroups = processGroups.filter(
    (pg) =>
      !(pgisByPg.get(pg.entityId ?? "") ?? 0) && !hasTargetOfType(pg, "PROCESS_GROUP_INSTANCE")
  );

  // HOST with no monitored PG / PGI → OneAgent present but nothing deep-monitored.
  const hostsWithNoMonitoredPg = hosts.filter(
    (h) => !hasTargetOfType(h, "PROCESS_GROUP", "PROCESS_GROUP_INSTANCE")
  );

  const inactiveHosts = hosts.filter(
    (h) => typeof h.lastSeenTms === "number" && nowMs - h.lastSeenTms > inactiveAfterMs
  );

  return { orphanServices, zombieProcessGroups, hostsWithNoMonitoredPg, inactiveHosts };
}
