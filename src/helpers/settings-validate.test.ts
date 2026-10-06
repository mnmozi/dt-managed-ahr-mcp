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
import {
  hintFor,
  parseItemArray,
  preValidateSettings,
  validateSettingsBatch,
  type SettingsPayload,
} from "./settings-validate.js";
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

// Bodies below are verbatim validateOnly responses from Managed 1.350.7.
const cpuQuota: SettingsPayload = {
  schemaId: "builtin:logmonitoring.log-agent-cpu-quota",
  scope: "environment",
  value: { LAConfigCpuQuota: "lots" },
};
const cpuQuotaTypeError = {
  code: 400,
  error: {
    code: 400,
    message: "Validation failed for 1 Validators.",
    constraintViolations: [
      {
        path: "builtin:logmonitoring.log-agent-cpu-quota/0/LAConfigCpuQuota",
        message: "Must be of type float",
        parameterLocation: "PAYLOAD_BODY",
        location: null,
      },
    ],
  },
  invalidValue: { LAConfigCpuQuota: "lots" },
};

describe("preValidateSettings — per-item errors on a 4xx (Managed 1.350)", () => {
  it("attributes a single-object 400 to its item instead of '<batch>'", async () => {
    requestMock.mockResolvedValueOnce(makeResp(400, JSON.stringify([cpuQuotaTypeError])));
    const r = await preValidateSettings(makeClient(), "dt_create_settings", [cpuQuota]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems).toHaveLength(1);
      expect(r.invalidItems[0]!.index).toBe(0);
      expect(r.invalidItems[0]!.schemaId).toBe("builtin:logmonitoring.log-agent-cpu-quota");
      expect(JSON.stringify(r.invalidItems[0]!.error)).toContain("Must be of type float");
    }
  });

  it("attributes a wrong-scope 404 and adds a hint", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        404,
        JSON.stringify([
          { code: 404, error: { code: 404, message: "No write access for scope class PROCESS_GROUP" } },
        ])
      )
    );
    const r = await preValidateSettings(makeClient(), "dt_create_settings", [
      { ...cpuQuota, scope: "PROCESS_GROUP-0000000000000001" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.invalidItems[0]!.index).toBe(0);
      expect(r.invalidItems[0]!.hint).toMatch(/allowedScopes/);
    }
  });

  it("parses a 207 mixed batch and reports only the failing items", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(207, JSON.stringify([{ code: 200 }, cpuQuotaTypeError]))
    );
    const outcome = await validateSettingsBatch(makeClient(), "dt_validate_settings", [
      { ...cpuQuota, value: { LAConfigCpuQuota: 50 } },
      cpuQuota,
    ]);
    expect(outcome.kind).toBe("items");
    if (outcome.kind === "items") {
      expect(outcome.status).toBe(207);
      expect(outcome.invalid.map((i) => i.index)).toEqual([1]);
    }
  });

  it("falls back to a batch-level error when the 4xx body is not an item array", async () => {
    requestMock.mockResolvedValueOnce(makeResp(401, JSON.stringify({ error: { code: 401, message: "bad token" } })));
    const outcome = await validateSettingsBatch(makeClient(), "dt_validate_settings", [cpuQuota]);
    expect(outcome.kind).toBe("api-error");
  });
});

describe("hintFor", () => {
  it.each([
    ["Schema builtin:bizevents.http.incoming is not supported for managed deployments.", /only on SaaS/],
    ["No schema with topic identifier 'Not allowed for non-DPS license'", /DPS license/],
    ["No schema with topic identifier 'builtin:process-group.advanced-detection-rule'", /dt_list_schemas/],
    ["Configuration schema builtin:network-zones does not exist.", /dt_list_schemas/],
    ["No write access for scope class PROCESS_GROUP", /allowedScopes/],
  ])("translates %s", (message, want) => {
    expect(hintFor({ message })).toMatch(want);
  });

  it("flags unknown properties from constraint violations", () => {
    expect(
      hintFor({
        message: "Validation failed for 3 Validators.",
        constraintViolations: [{ path: "builtin:management-zones/0/rules/0/bogus", message: "Unknown property" }],
      })
    ).toMatch(/dt_get_schema/);
  });

  it("returns nothing for an ordinary type error", () => {
    expect(hintFor(cpuQuotaTypeError.error)).toBeUndefined();
  });
});

describe("parseItemArray", () => {
  it("rejects arrays that do not match the batch length", () => {
    expect(parseItemArray(JSON.stringify([{ code: 200 }]), 2)).toBeNull();
  });
  it("rejects non-JSON", () => {
    expect(parseItemArray("<html>", 1)).toBeNull();
  });
});
