import { describe, it, expect } from "vitest";
import { classifyOrphans, relatedTargets } from "./orphan-classify.js";

const DAY = 86_400_000;

describe("relatedTargets", () => {
  it("merges both relationship maps and tolerates missing / malformed buckets", () => {
    const targets = relatedTargets({
      fromRelationships: { isInstanceOf: [{ id: "PROCESS_GROUP-1", type: "PROCESS_GROUP" }] },
      toRelationships: {
        runsOnProcessGroupInstance: [{ id: "SERVICE-1", type: "SERVICE" }],
        weird: undefined as unknown as [],
      },
    });
    expect(targets.map((t) => t.id)).toEqual(["PROCESS_GROUP-1", "SERVICE-1"]);
    expect(relatedTargets({})).toEqual([]);
  });
});

describe("classifyOrphans", () => {
  it("does not flag a service whose PGI link lives in fromRelationships while toRelationships is present but unrelated", () => {
    const out = classifyOrphans({
      services: [
        {
          entityId: "SERVICE-OK",
          fromRelationships: { runsOnProcessGroupInstance: [{ id: "PGI-1", type: "PROCESS_GROUP_INSTANCE" }] },
          toRelationships: { calls: [{ id: "SERVICE-X", type: "SERVICE" }] },
        },
        { entityId: "SERVICE-ORPHAN", fromRelationships: {}, toRelationships: {} },
      ],
      hosts: [],
      processGroups: [],
      processGroupInstances: [],
      nowMs: 0,
      inactiveAfterMs: 7 * DAY,
    });
    expect(out.orphanServices.map((s) => s.entityId)).toEqual(["SERVICE-ORPHAN"]);
  });

  it("counts PGIs per PG via the PGI's fromRelationships.isInstanceOf", () => {
    const out = classifyOrphans({
      services: [],
      hosts: [],
      processGroups: [
        { entityId: "PROCESS_GROUP-LIVE", fromRelationships: {}, toRelationships: {} },
        { entityId: "PROCESS_GROUP-ZOMBIE", fromRelationships: {}, toRelationships: {} },
        {
          entityId: "PROCESS_GROUP-LINKED-ON-PG-SIDE",
          toRelationships: { isInstanceOf: [{ id: "PGI-9", type: "PROCESS_GROUP_INSTANCE" }] },
        },
      ],
      processGroupInstances: [
        {
          entityId: "PGI-1",
          fromRelationships: { isInstanceOf: [{ id: "PROCESS_GROUP-LIVE", type: "PROCESS_GROUP" }] },
          toRelationships: { runsOnProcessGroupInstance: [{ id: "SERVICE-1", type: "SERVICE" }] },
        },
      ],
      nowMs: 0,
      inactiveAfterMs: 7 * DAY,
    });
    expect(out.zombieProcessGroups.map((p) => p.entityId)).toEqual(["PROCESS_GROUP-ZOMBIE"]);
  });

  it("flags hosts with no PG/PGI link and hosts not seen within the threshold", () => {
    const now = 100 * DAY;
    const out = classifyOrphans({
      services: [],
      hosts: [
        {
          entityId: "HOST-OK",
          lastSeenTms: now - DAY,
          toRelationships: { isProcessOf: [{ id: "PGI-1", type: "PROCESS_GROUP_INSTANCE" }] },
        },
        { entityId: "HOST-SILENT", lastSeenTms: now - DAY, toRelationships: {} },
        {
          entityId: "HOST-INACTIVE",
          lastSeenTms: now - 10 * DAY,
          toRelationships: { runsOn: [{ id: "PROCESS_GROUP-1", type: "PROCESS_GROUP" }] },
        },
        { entityId: "HOST-NO-TIMESTAMP", toRelationships: { runsOn: [{ id: "PROCESS_GROUP-1", type: "PROCESS_GROUP" }] } },
      ],
      processGroups: [],
      processGroupInstances: [],
      nowMs: now,
      inactiveAfterMs: 7 * DAY,
    });
    expect(out.hostsWithNoMonitoredPg.map((h) => h.entityId)).toEqual(["HOST-SILENT"]);
    expect(out.inactiveHosts.map((h) => h.entityId)).toEqual(["HOST-INACTIVE"]);
  });
});
