import { describe, it, expect } from "vitest";
import { fetchOneAgents, normalizeModule, normalizeV1Host, versionString } from "./oneagents.js";
import { DtApiError, type DtClient } from "../dt-client.js";

function clientWith(routes: Record<string, (q?: Record<string, unknown>) => unknown>): DtClient {
  return {
    get: async (path: string, opts?: { query?: Record<string, unknown> }) => {
      const handler = routes[path];
      if (!handler) throw new DtApiError(404, "GET", path, "HTTP 404 Not Found");
      return handler(opts?.query);
    },
  } as unknown as DtClient;
}

const v1Host = {
  hostInfo: {
    displayName: "ip-10-0-0-1.ec2.internal",
    entityId: "HOST-0000000000000001",
    osType: "LINUX",
    monitoringMode: "FULL_STACK",
    agentVersion: { major: 1, minor: 346, revision: 12, sourceRevision: "abc" },
    softwareTechnologies: [{ type: "KUBERNETES", edition: "worker", version: "v1.35" }],
  },
  monitoringType: "FULL_STACK",
  modules: [{ moduleType: "LOG_ANALYTICS", enabled: true }],
};

describe("versionString", () => {
  it("joins the v1 version object and passes strings through", () => {
    expect(versionString({ major: 1, minor: 346, revision: 12 })).toBe("1.346.12");
    expect(versionString("1.345.0")).toBe("1.345.0");
    expect(versionString(undefined)).toBeUndefined();
    expect(versionString({})).toBeUndefined();
  });
});

describe("normalizeV1Host", () => {
  it("maps v1 names onto the v2 contract without losing raw fields", () => {
    const h = normalizeV1Host(v1Host as never);
    expect(h.hostInfo?.hostName).toBe("ip-10-0-0-1.ec2.internal");
    expect(h.hostInfo?.entityId).toBe("HOST-0000000000000001");
    expect(h.currentVersion).toBe("1.346.12");
    expect(h.detectedTechnologies).toEqual([{ type: "KUBERNETES", version: "v1.35" }]);
    expect(h.modules).toEqual([{ moduleType: "LOG_ANALYTICS", enabled: true }]);
    expect((h.hostInfo as Record<string, unknown>).displayName).toBeDefined();
  });

  it("never overwrites v2-style fields that are already present", () => {
    const h = normalizeV1Host({ ...v1Host, currentVersion: "9.9.9", hostInfo: { ...v1Host.hostInfo, hostName: "given" } } as never);
    expect(h.currentVersion).toBe("9.9.9");
    expect(h.hostInfo?.hostName).toBe("given");
  });
});

describe("fetchOneAgents", () => {
  it("uses v2 with pagination when it exists", async () => {
    const client = clientWith({
      "/api/v2/oneagents": (q) =>
        q?.nextPageKey
          ? { hosts: [{ hostInfo: { hostName: "b" } }] }
          : { hosts: [{ hostInfo: { hostName: "a" } }], nextPageKey: "k" },
    });
    const inv = await fetchOneAgents(client, { fields: "+modules" });
    expect(inv.source).toBe("v2");
    expect(inv.hosts.map((h) => h.hostInfo?.hostName)).toEqual(["a", "b"]);
  });

  it("falls back to v1 with includeDetails when v2 is 404 and normalizes", async () => {
    let v1Query: Record<string, unknown> | undefined;
    const client = clientWith({
      "/api/v1/oneagents": (q) => {
        v1Query = q;
        return { hosts: [v1Host] };
      },
    });
    const inv = await fetchOneAgents(client);
    expect(inv.source).toBe("v1");
    expect(v1Query?.includeDetails).toBe(true);
    expect(inv.hosts[0]?.hostInfo?.hostName).toBe("ip-10-0-0-1.ec2.internal");
    expect(inv.hosts[0]?.currentVersion).toBe("1.346.12");
  });

  it("propagates non-404 failures instead of masking them with v1", async () => {
    const client = {
      get: async () => {
        throw new DtApiError(403, "GET", "/api/v2/oneagents", "forbidden");
      },
    } as unknown as DtClient;
    await expect(fetchOneAgents(client)).rejects.toThrow(/403/);
  });
});

describe("normalizeModule", () => {
  // Shape from /api/v1/oneagents?includeDetails=true on Managed 1.350.7.
  it("folds v1 instances[] into enabled/version", () => {
    const m = normalizeModule({
      moduleType: "LOG_ANALYTICS",
      instances: [{ instanceName: "x", moduleVersion: "1.345.68.20260903-162827", active: true }],
    });
    expect(m.enabled).toBe(true);
    expect(m.version).toBe("1.345.68.20260903-162827");
  });

  it("treats a module whose instances are all inactive as disabled", () => {
    expect(normalizeModule({ moduleType: "JAVA", instances: [{ active: false }, {}] }).enabled).toBe(false);
  });

  it("leaves an explicit enabled flag alone", () => {
    expect(normalizeModule({ moduleType: "LOG_ANALYTICS", enabled: false, instances: [{ active: true }] }).enabled).toBe(false);
  });

  it("is applied by normalizeV1Host", () => {
    const h = normalizeV1Host({ ...v1Host, modules: [{ moduleType: "LOG_ANALYTICS", instances: [{ active: true }] }] } as never);
    expect(h.modules?.[0]?.enabled).toBe(true);
  });
});
