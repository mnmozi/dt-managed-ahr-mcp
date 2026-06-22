import { describe, it, expect } from "vitest";
import { checkClusterDenyList, CLUSTER_DENY_PREFIXES } from "./cluster-deny-list.js";
import { setLogLevel } from "../logger.js";

setLogLevel("error");

describe("checkClusterDenyList", () => {
  it("allows a normal tenant-scoped path", () => {
    const d = checkClusterDenyList("/api/v2/settings/objects");
    expect(d.denied).toBe(false);
  });

  it("denies the cluster configuration prefix", () => {
    const d = checkClusterDenyList("/api/v1/cluster/configuration/cluster-stats");
    expect(d.denied).toBe(true);
    expect(d.matchedPrefix).toBe("/api/v1/cluster/configuration");
    expect(d.reason).toMatch(/cluster-admin/);
  });

  it("denies the onpremise users path", () => {
    const d = checkClusterDenyList("/api/v1.0/onpremise/users/some-id");
    expect(d.denied).toBe(true);
    expect(d.hint).toMatch(/CMC users/);
  });

  it("denies regardless of case", () => {
    const d = checkClusterDenyList("/API/V1/CLUSTER/CONFIGURATION/whatever");
    expect(d.denied).toBe(true);
  });

  it("strips query/fragment before matching", () => {
    const d = checkClusterDenyList("/api/v1.0/onpremise/license?force=1#section");
    expect(d.denied).toBe(true);
  });

  it("strips scheme+host when caller pastes a full URL", () => {
    const d = checkClusterDenyList("https://example.com/api/v1.0/onpremise/backup/foo");
    expect(d.denied).toBe(true);
    expect(d.matchedPrefix).toBe("/api/v1.0/onpremise/backup");
  });

  it("handles missing leading slash", () => {
    const d = checkClusterDenyList("api/v1/cluster/configuration/x");
    expect(d.denied).toBe(true);
  });

  it("returns denied=false for empty / non-string path", () => {
    expect(checkClusterDenyList("").denied).toBe(false);
    expect(checkClusterDenyList(undefined as unknown as string).denied).toBe(false);
  });

  it("every deny prefix is reachable", () => {
    for (const { prefix } of CLUSTER_DENY_PREFIXES) {
      const d = checkClusterDenyList(prefix + "/anything");
      expect(d.denied).toBe(true);
      expect(d.matchedPrefix).toBe(prefix);
    }
  });
});
