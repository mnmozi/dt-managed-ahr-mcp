import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock undici before importing DtClient
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
import { preValidateSettings, type SettingsPayload } from "./settings-validate.js";
import { setLogLevel } from "../logger.js";

setLogLevel("error");

const requestMock = request as unknown as ReturnType<typeof vi.fn>;

function makeResp(status: number, body = "", headers: Record<string, string> = {}): unknown {
  return {
    statusCode: status,
    headers,
    body: { text: async () => body },
  };
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

const sampleBody: SettingsPayload[] = [
  { schemaId: "builtin:tags.auto-tagging", scope: "environment", value: { name: "x" } },
  { schemaId: "builtin:tags.auto-tagging", scope: "environment", value: { name: "y" } },
];

beforeEach(() => {
  requestMock.mockReset();
});

describe("preValidateSettings", () => {
  it("returns ok=true when every item validates", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify([
          { code: 200, objectId: "id-1" },
          { code: 200, objectId: "id-2" },
        ])
      )
    );
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(true);
  });

  it("returns ok=true when response is an empty array (no items, no errors)", async () => {
    requestMock.mockResolvedValueOnce(makeResp(200, JSON.stringify([])));
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(true);
  });

  it("refuses when an item has an error block", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify([
          { code: 200, objectId: "id-1" },
          {
            error: {
              code: 400,
              message: "name must be unique",
              constraintViolations: [{ path: "name", message: "duplicate" }],
            },
          },
        ])
      )
    );
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(1);
      expect(r.invalidItems[0]!.index).toBe(1);
      expect(r.invalidItems[0]!.schemaId).toBe("builtin:tags.auto-tagging");
      expect(r.refusal.isError).toBe(true);
    }
  });

  it("refuses when an item has a non-2xx code", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify([
          { code: 200, objectId: "id-1" },
          { code: 400 },
        ])
      )
    );
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(1);
      expect(r.invalidItems[0]!.index).toBe(1);
      expect(String(r.invalidItems[0]!.error)).toMatch(/unexpected validate code 400/);
    }
  });

  it("collects multiple invalid items in order", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify([
          { error: { code: 400, message: "bad name" } },
          { error: { code: 400, message: "bad scope" } },
        ])
      )
    );
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(2);
      expect(r.invalidItems[0]!.index).toBe(0);
      expect(r.invalidItems[1]!.index).toBe(1);
    }
  });

  it("refuses when the validate API returns 4xx (DtApiError path)", async () => {
    requestMock.mockResolvedValueOnce(makeResp(400, JSON.stringify({ error: "malformed" })));
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(1);
      expect(r.invalidItems[0]!.index).toBe(-1);
      expect(String(r.invalidItems[0]!.error)).toMatch(/validate API returned HTTP 400/);
      expect(r.refusal.isError).toBe(true);
    }
  });

  it("refuses when the validate API has a transport / network failure", async () => {
    requestMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(1);
      expect(String(r.invalidItems[0]!.error)).toMatch(/ECONNREFUSED/);
      expect(r.refusal.isError).toBe(true);
    }
  });

  it("tolerates a non-array success body (treats as no failures)", async () => {
    // Some clusters may return an object on empty / odd payloads. We treat
    // "no per-item errors found" as ok rather than refusing — the real create
    // will surface any deeper issue.
    requestMock.mockResolvedValueOnce(makeResp(200, JSON.stringify({ ok: true })));
    const r = await preValidateSettings(makeClient(), "dt_create_settings", sampleBody);
    expect(r.ok).toBe(true);
  });
});
