import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("undici", () => {
  const requestMock = vi.fn();
  class AgentStub {
    constructor(_opts?: unknown) {}
    async close() {}
  }
  return { request: requestMock, Agent: AgentStub };
});

import { request } from "undici";
import { DtClient } from "../dt-client.js";
import { checkAlreadyExists, NAME_FIELD_BY_SCHEMA } from "./already-exists.js";
import { setLogLevel } from "../logger.js";

setLogLevel("error");

const requestMock = request as unknown as ReturnType<typeof vi.fn>;

function makeResp(status: number, body = ""): unknown {
  return { statusCode: status, headers: {}, body: { text: async () => body } };
}

function makeClient(): DtClient {
  process.env.DT_HTTP_BACKOFF_MS = "1";
  process.env.DT_HTTP_MAX_BACKOFF_MS = "5";
  return new DtClient({
    clusterUrl: "https://example",
    envId: "env",
    token: "t",
    clusterToken: null,
    writeToken: "w",
    tlsVerify: false,
    auditDir: "/tmp",
  });
}

beforeEach(() => requestMock.mockReset());

describe("checkAlreadyExists", () => {
  it("returns ok=true when no existing object has the same name", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ items: [{ objectId: "id-1", value: { name: "other" } }] }))
    );
    const r = await checkAlreadyExists(makeClient(), "dt_create_settings", [
      { schemaId: "builtin:management-zones", scope: "environment", value: { name: "mine" } },
    ]);
    expect(r.ok).toBe(true);
  });

  it("returns ok=false when a collision exists", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify({ items: [{ objectId: "existing-id", value: { name: "mine" } }] })
      )
    );
    const r = await checkAlreadyExists(makeClient(), "dt_create_settings", [
      { schemaId: "builtin:management-zones", scope: "environment", value: { name: "mine" } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0]!.existingObjectId).toBe("existing-id");
      expect(r.conflicts[0]!.name).toBe("mine");
      expect(r.refusal.isError).toBe(true);
    }
  });

  it("skips unknown schemas silently and reports them", async () => {
    const r = await checkAlreadyExists(makeClient(), "dt_create_settings", [
      { schemaId: "builtin:something-unknown", scope: "environment", value: { name: "x" } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skippedItems).toEqual([0]);
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("skips items without a name value", async () => {
    const r = await checkAlreadyExists(makeClient(), "dt_create_settings", [
      { schemaId: "builtin:management-zones", scope: "environment", value: { foo: "bar" } },
    ]);
    expect(r.ok).toBe(true);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("skips the check on list-fetch error and proceeds", async () => {
    requestMock.mockResolvedValue(makeResp(500, "boom"));
    const r = await checkAlreadyExists(makeClient(), "dt_create_settings", [
      { schemaId: "builtin:management-zones", scope: "environment", value: { name: "x" } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skippedItems).toEqual([0]);
    }
  });

  it("uses the right name field per schema", () => {
    // Sanity check on the map — these should all be schemas users commonly create.
    expect(NAME_FIELD_BY_SCHEMA["builtin:management-zones"]).toBe("name");
    expect(NAME_FIELD_BY_SCHEMA["builtin:problem.notifications"]).toBe("displayName");
    expect(NAME_FIELD_BY_SCHEMA["builtin:anomaly-detection.metric-events"]).toBe("summary");
  });
});
