import { describe, it, expect, beforeEach } from "vitest";
import { registerSchemaWrapper, resetSchemaInventoryCache } from "./schema-wrapper.js";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * P3.1 regression guard: a wrapper whose every schema probe 404s must
 * surface a loud SURFACE_MISSING state (isError:true + warning), never a
 * quiet empty success — that's the failure mode that made six tools lie
 * on Managed 1.346. Companion endpoints (Config v1 / v2) rescue the
 * surface into "config-v1-only".
 */

type Handler = (args: { scopeFilter?: string }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureHandler(): { server: { registerTool: (...a: unknown[]) => void }; get: () => Handler } {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: unknown, _cfg: unknown, h: unknown) => {
      handler = h as Handler;
    },
  };
  return {
    server,
    get: () => {
      if (!handler) throw new Error("handler not registered");
      return handler;
    },
  };
}

function fakeClient(routes: Record<string, unknown | (() => never)>): DtClient {
  return {
    get: async (path: string, opts?: { query?: Record<string, unknown> }) => {
      // Settings probes route by schemaId; companions route by path.
      const key = path === "/api/v2/settings/objects" ? String(opts?.query?.schemaIds) : path;
      const entry = routes[key];
      if (entry === undefined) {
        throw new DtApiError(404, "GET", key, "no such route in fake");
      }
      if (typeof entry === "function") return (entry as () => never)();
      return entry;
    },
  } as unknown as DtClient;
}

const dead = () => {
  throw new DtApiError(404, "GET", "/api/v2/settings/objects", "schema not found");
};

async function run(handler: Handler) {
  const res = await handler({});
  return { parsed: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
}

describe("schema-wrapper surfaceStatus", () => {
  // The inventory is cached per process; each test starts clean. Fakes
  // without a "/api/v2/settings/schemas" route exercise the fallback
  // (inventory unavailable -> trust the objects endpoint).
  beforeEach(() => resetSchemaInventoryCache());

  it("returns ok when at least one schema probe answers", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(
      cap.server as never,
      fakeClient({ "builtin:old": dead, "builtin:new": { items: [{ objectId: "x" }] } }),
      { toolName: "t", description: "d", schemaIds: ["builtin:old", "builtin:new"] }
    );
    const { parsed, isError } = await run(cap.get());
    expect(parsed.surfaceStatus).toBe("ok");
    expect(isError).toBe(false);
  });

  it("goes loud (SURFACE_MISSING + isError) when every probe is dead", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(cap.server as never, fakeClient({ "builtin:gone": dead }), {
      toolName: "t",
      description: "d",
      schemaIds: ["builtin:gone"],
    });
    const { parsed, isError } = await run(cap.get());
    expect(parsed.surfaceStatus).toBe("SURFACE_MISSING");
    expect(parsed.warning).toMatch(/Do NOT read this as 'nothing configured'/);
    expect(isError).toBe(true);
  });

  it("reports config-v1-only when probes are dead but a companion answers", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(
      cap.server as never,
      fakeClient({ "builtin:gone": dead, "/api/config/v1/thing": { values: [{ id: "r1" }] } }),
      {
        toolName: "t",
        description: "d",
        schemaIds: ["builtin:gone"],
        companionEndpoints: [{ path: "/api/config/v1/thing", label: "thing-v1" }],
      }
    );
    const { parsed, isError } = await run(cap.get());
    expect(parsed.surfaceStatus).toBe("config-v1-only");
    expect(parsed.companionEndpoints["thing-v1"].status).toBe("ok");
    expect(isError).toBe(false);
  });

  it("treats companion 404 as unsupported-on-this-version when flagged, without rescuing the surface", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(
      cap.server as never,
      fakeClient({ "builtin:gone": dead }),
      {
        toolName: "t",
        description: "d",
        schemaIds: ["builtin:gone"],
        companionEndpoints: [
          { path: "/api/config/v1/absent", label: "absent-v1", notFoundMeansUnsupported: true },
        ],
      }
    );
    const { parsed, isError } = await run(cap.get());
    expect(parsed.companionEndpoints["absent-v1"].status).toBe("unsupported-on-this-version");
    expect(parsed.surfaceStatus).toBe("SURFACE_MISSING");
    expect(isError).toBe(true);
  });

  it("treats a 200 for an unadvertised schema as phantom, not alive", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(
      cap.server as never,
      fakeClient({
        "/api/v2/settings/schemas": { items: [{ schemaId: "builtin:real" }] },
        "builtin:ghost": { items: [], totalCount: 0 },
      }),
      { toolName: "t", description: "d", schemaIds: ["builtin:ghost"] }
    );
    const { parsed, isError } = await run(cap.get());
    expect(parsed.schemas[0].phantom).toBe(true);
    expect(parsed.surfaceStatus).toBe("SURFACE_MISSING");
    expect(isError).toBe(true);
  });

  it("counts an advertised schema as alive alongside a phantom one", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(
      cap.server as never,
      fakeClient({
        "/api/v2/settings/schemas": { items: [{ schemaId: "builtin:real" }] },
        "builtin:ghost": { items: [], totalCount: 0 },
        "builtin:real": { items: [{ objectId: "x" }], totalCount: 1 },
      }),
      { toolName: "t", description: "d", schemaIds: ["builtin:ghost", "builtin:real"] }
    );
    const { parsed, isError } = await run(cap.get());
    expect(parsed.schemas[0].phantom).toBe(true);
    expect(parsed.schemas[1].phantom).toBeUndefined();
    expect(parsed.surfaceStatus).toBe("ok");
    expect(isError).toBe(false);
  });

  it("includes the staticNote verbatim", async () => {
    const cap = captureHandler();
    registerSchemaWrapper(cap.server as never, fakeClient({ "builtin:bizevents": dead }), {
      toolName: "t",
      description: "d",
      schemaIds: ["builtin:bizevents"],
      staticNote: "SaaS/Grail-only; absence on Managed is expected.",
    });
    const { parsed, isError } = await run(cap.get());
    expect(parsed.note).toBe("SaaS/Grail-only; absence on Managed is expected.");
    expect(parsed.surfaceStatus).toBe("not-available-on-this-platform");
    expect(parsed.warning).toBeUndefined();
    expect(isError).toBe(false);
  });
});
