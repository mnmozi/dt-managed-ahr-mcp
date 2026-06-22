import { describe, it, expect } from "vitest";
import { generateRemediation } from "./hostgroup-remediation.js";
import type { HostGroupsCoverageAuditOutput } from "../engine/analyzers/hostgroups-coverage-audit.js";

// A representative audit output covering each category. Mirrors the
// engine's scenario-issues golden fixture so the helper is exercised
// against shapes the real analyzer produces.
const sampleAudit: HostGroupsCoverageAuditOutput = {
  hostsWithoutGroup: [
    {
      hostId: "HOST-NOGROUP",
      displayName: "host-nogroup",
      fleetSuggestion: "orders-api",
      evidence: "fleet match with 6 hosts already in 'orders-api'",
    },
    {
      hostId: "HOST-LONE",
      displayName: "host-lone",
      // no fleetSuggestion — engine had no fleet signal for this host
    },
  ],
  splitFleets: [
    {
      fleetKey: "117d16480bc550b1",
      memberCount: 8,
      currentDistribution: { "orders-api": 6, "orders-apii": 1, "<none>": 1 },
      suggestedGroup: "orders-api",
      hostsToReassign: [
        {
          hostId: "HOST-NOGROUP",
          displayName: "host-nogroup",
          newGroup: "orders-api",
          reason: "split fleet — 6 of 8 fleet-mates already in 'orders-api'",
        },
        {
          hostId: "HOST-TYPO",
          displayName: "host-typo",
          currentGroup: "orders-apii",
          newGroup: "orders-api",
          reason: "split fleet — 6 of 8 fleet-mates already in 'orders-api'",
        },
      ],
    },
  ],
  singleMemberLikelyTypos: [
    {
      groupName: "orders-apii",
      memberCount: 1,
      nearestPopulatedGroup: "orders-api",
      nearestMemberCount: 6,
      editDistance: 1,
    },
  ],
  genericGroupNames: [
    { groupName: "default", memberCount: 1, reason: "default placeholder name" },
  ],
  namingDrift: [],
  counts: {
    totalHosts: 11,
    totalHostGroups: 5,
    hostsWithoutGroup: 2,
    splitFleets: 1,
    singleMemberLikelyTypos: 1,
    genericGroupNames: 1,
    namingDriftClusters: 0,
  },
  appliedDefaults: { minFleetSize: 2, maxEditDistance: 2 },
};

describe("generateRemediation", () => {
  it("returns no commands when accept is empty", () => {
    const r = generateRemediation(sampleAudit, {});
    expect(r.commandsByHost).toHaveLength(0);
    expect(r.summary.commandsGenerated).toBe(0);
    expect(r.unmatchedSelectors).toHaveLength(0);
  });

  it("emits a oneagentctl command for a picked hostsWithoutGroup with engine suggestion", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-NOGROUP" }],
    });
    expect(r.commandsByHost).toHaveLength(1);
    const cmd = r.commandsByHost[0]!;
    expect(cmd.hostId).toBe("HOST-NOGROUP");
    expect(cmd.newGroup).toBe("orders-api");
    expect(cmd.currentGroup).toBe("<none>");
    expect(cmd.command).toBe(
      "sudo /opt/dynatrace/oneagent/agent/tools/oneagentctl --set-host-group=orders-api --restart-service"
    );
  });

  it("requires assignToGroup when the entry has no fleetSuggestion", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-LONE" }],
    });
    expect(r.commandsByHost).toHaveLength(0);
    expect(r.unmatchedSelectors[0]).toMatch(/HOST-LONE.*assignToGroup/);
  });

  it("honors operator assignToGroup override", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-LONE", assignToGroup: "manual-group" }],
    });
    expect(r.commandsByHost).toHaveLength(1);
    expect(r.commandsByHost[0]!.newGroup).toBe("manual-group");
    expect(r.commandsByHost[0]!.reason).toMatch(/operator-supplied/);
  });

  it("emits one command per reassignment when a splitFleet is picked", () => {
    const r = generateRemediation(sampleAudit, {
      splitFleets: ["117d16480bc550b1"],
    });
    expect(r.commandsByHost).toHaveLength(2);
    const ids = r.commandsByHost.map((c) => c.hostId).sort();
    expect(ids).toEqual(["HOST-NOGROUP", "HOST-TYPO"]);
  });

  it("dedupes hosts that appear in both hostsWithoutGroup AND splitFleets", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-NOGROUP" }],
      splitFleets: ["117d16480bc550b1"],
    });
    // HOST-NOGROUP appears in both selectors — should be 2 commands total,
    // not 3 (HOST-NOGROUP once, HOST-TYPO once).
    expect(r.commandsByHost).toHaveLength(2);
    expect(r.commandsByHost.map((c) => c.hostId).sort()).toEqual(["HOST-NOGROUP", "HOST-TYPO"]);
  });

  it("reports unmatched selectors instead of throwing", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-DOES-NOT-EXIST" }],
      splitFleets: ["bogus-fleet-key"],
    });
    expect(r.commandsByHost).toHaveLength(0);
    expect(r.unmatchedSelectors).toContain(
      "hostsWithoutGroup: hostId='HOST-DOES-NOT-EXIST' not in audit"
    );
    expect(r.unmatchedSelectors).toContain(
      "splitFleets: fleetKey='bogus-fleet-key' not in audit"
    );
  });

  it("emits an Ansible fragment when ≥ 2 hosts", () => {
    const r = generateRemediation(sampleAudit, {
      splitFleets: ["117d16480bc550b1"],
    });
    expect(r.ansibleInventoryFragment).toBeDefined();
    expect(r.ansibleInventoryFragment!).toMatch(/\[set_host_group__orders_api\]/);
    expect(r.ansibleInventoryFragment!).toMatch(/host-nogroup/);
    expect(r.ansibleInventoryFragment!).toMatch(/host-typo  # was: orders-apii/);
  });

  it("skips Ansible fragment for single-host remediation", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-NOGROUP" }],
    });
    expect(r.commandsByHost).toHaveLength(1);
    expect(r.ansibleInventoryFragment).toBeUndefined();
  });

  it("shell-quotes group names with metacharacters", () => {
    const r = generateRemediation(sampleAudit, {
      hostsWithoutGroup: [{ hostId: "HOST-LONE", assignToGroup: "weird group with spaces" }],
    });
    expect(r.commandsByHost[0]!.command).toMatch(/--set-host-group="weird group with spaces"/);
  });

  it("estimates downtime and counts correctly", () => {
    const r = generateRemediation(sampleAudit, {
      splitFleets: ["117d16480bc550b1"],
    });
    expect(r.summary.commandsGenerated).toBe(2);
    expect(r.summary.hostsAffected).toBe(2);
    expect(r.summary.estimatedDowntimeSeconds).toBeGreaterThan(0);
  });
});
