import { describe, it, expect } from "vitest";
import { clusterRead, redactSecrets } from "./cluster-read.js";
import { DtApiError, type DtClient } from "../dt-client.js";

function fake(routes: Record<string, unknown | (() => never)>): DtClient {
  return {
    get: async (path: string, opts?: { scope?: string }) => {
      if (opts?.scope !== "cluster") throw new Error(`expected cluster scope for ${path}`);
      const entry = routes[path];
      if (entry === undefined) throw new DtApiError(404, "GET", path, "not found");
      if (typeof entry === "function") return (entry as () => never)();
      return entry;
    },
  } as unknown as DtClient;
}

describe("redactSecrets", () => {
  it("masks non-empty secret-looking strings at any depth and keeps structure", () => {
    const got = redactSecrets({
      hostName: "smtp", password: "p@ss", isPasswordConfigured: true, bindPassword: "",
      nested: [{ clientSecret: "abc", name: "x" }],
    });
    expect(got).toEqual({
      hostName: "smtp", password: "<redacted>", isPasswordConfigured: true, bindPassword: "",
      nested: [{ clientSecret: "<redacted>", name: "x" }],
    });
  });
});

describe("clusterRead", () => {
  it("reports ok / unsupported / error per endpoint and a partial surface", async () => {
    const client = fake({
      "/api/v1.0/onpremise/cluster": [{ id: 1, operationState: "RUNNING" }],
      "/api/v1.0/onpremise/smtp": { hostName: "h", password: "x" },
      "/api/v1.0/onpremise/users": () => {
        throw new DtApiError(403, "GET", "/api/v1.0/onpremise/users", "forbidden");
      },
    });
    const res = await clusterRead(client, [
      { label: "nodes", path: "/api/v1.0/onpremise/cluster" },
      { label: "smtp", path: "/api/v1.0/onpremise/smtp" },
      { label: "proxy", path: "/api/v1.0/onpremise/proxy/configurations", optional: true },
      { label: "users", path: "/api/v1.0/onpremise/users" },
    ]);
    expect(res.available).toBe(true);
    expect(res.surfaceStatus).toBe("partial");
    expect(res.endpoints?.nodes.status).toBe("ok");
    expect(res.endpoints?.proxy.status).toBe("unsupported-on-this-version");
    expect(res.endpoints?.users).toMatchObject({ status: "error", httpStatus: 403 });
    expect((res.endpoints?.smtp as { data: { password: string } }).data.password).toBe("<redacted>");
  });

  it("goes SURFACE_MISSING when nothing answers", async () => {
    const res = await clusterRead(fake({}), [{ label: "a", path: "/api/v1.0/onpremise/gone" }]);
    expect(res.surfaceStatus).toBe("SURFACE_MISSING");
  });

  it("returns available:false with a hint when no cluster token is configured", async () => {
    const client = {
      get: async () => {
        throw new Error("cluster-scoped call requested but DT_CLUSTER_TOKEN_FILE is not configured");
      },
    } as unknown as DtClient;
    const res = await clusterRead(client, [{ label: "a", path: "/api/v1.0/onpremise/cluster" }]);
    expect(res.available).toBe(false);
    expect(res.hint).toMatch(/DT_CLUSTER_TOKEN/);
  });
});
