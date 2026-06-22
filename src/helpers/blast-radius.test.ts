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
import { checkBlastRadius } from "./blast-radius.js";
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

beforeEach(() => {
  requestMock.mockReset();
});

describe("checkBlastRadius", () => {
  it("returns ok=true with matched count and preview when below ack threshold", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify({
          totalCount: 5,
          entities: [
            { entityId: "HOST-1", displayName: "host-one" },
            { entityId: "HOST-2", displayName: "host-two" },
          ],
        })
      )
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matchedCount).toBe(5);
      expect(r.preview).toHaveLength(2);
      expect(r.preview[0]!.entityId).toBe("HOST-1");
      expect(r.preview[0]!.displayName).toBe("host-one");
    }
  });

  it("includes preview entities in the refusal when above ack threshold", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(
        200,
        JSON.stringify({
          totalCount: 50,
          entities: [
            { entityId: "HOST-A", displayName: "alpha" },
            { entityId: "HOST-B", displayName: "beta" },
          ],
        })
      )
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.preview).toHaveLength(2);
      // The refusal payload's text should include the preview list
      const text = r.refusal.content[0]!.text;
      expect(text).toMatch(/previewEntities/);
      expect(text).toMatch(/HOST-A/);
    }
  });

  it("refuses on zero matches", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 0, entities: [] }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST),entityId(NOPE)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/no entities/);
      expect(r.refusal.isError).toBe(true);
    }
  });

  it("refuses above ack threshold when expectedMatchCount is missing", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 50 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/expectedMatchCount/);
      expect(r.matchedCount).toBe(50);
    }
  });

  it("proceeds above ack threshold when expectedMatchCount matches", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 50 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
      expectedMatchCount: 50,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses when expected vs actual drift exceeds tolerance", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 120 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
      expectedMatchCount: 100, // 20% drift, default tolerance 5%
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/divergence/);
  });

  it("proceeds when drift is within tolerance", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 102 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
      expectedMatchCount: 100, // 2% drift, under 5%
    });
    expect(r.ok).toBe(true);
  });

  it("refuses above mass-change threshold without acknowledgeMassChange", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 1500 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
      expectedMatchCount: 1500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/acknowledgeMassChange/);
  });

  it("proceeds above mass-change threshold with acknowledgeMassChange:true", async () => {
    requestMock.mockResolvedValueOnce(
      makeResp(200, JSON.stringify({ totalCount: 1500 }))
    );
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
      expectedMatchCount: 1500,
      acknowledgeMassChange: true,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses when the pre-check HTTP call fails", async () => {
    requestMock.mockResolvedValueOnce(makeResp(500, "boom"));
    const r = await checkBlastRadius({
      client: makeClient(),
      tool: "dt_add_tag",
      entitySelector: "type(HOST)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pre-check failed/);
  });
});
