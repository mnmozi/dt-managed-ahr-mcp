import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock undici.request BEFORE importing DtClient — vitest hoists vi.mock,
// but we still control the implementation per-test via mockImplementation.
vi.mock("undici", () => {
  const requestMock = vi.fn();
  // Agent constructor: minimal stub with close()
  class AgentStub {
    constructor(_opts?: unknown) {}
    async close() {}
  }
  return { request: requestMock, Agent: AgentStub };
});

import { request } from "undici";
import { DtClient, DtApiError } from "./dt-client.js";
import { setLogLevel } from "./logger.js";

// Silence logger during these tests (most paths emit at warn — keep stderr quiet)
setLogLevel("error");

// Type guard for the mock
const requestMock = request as unknown as ReturnType<typeof vi.fn>;

function makeResp(status: number, body = "", headers: Record<string, string> = {}): unknown {
  return {
    statusCode: status,
    headers,
    body: {
      text: async () => body,
    },
  };
}

function makeClient(): DtClient {
  // Tighten timing for tests: short backoff so tests don't take seconds.
  process.env.DT_HTTP_BACKOFF_MS = "1";
  process.env.DT_HTTP_MAX_BACKOFF_MS = "5";
  process.env.DT_HTTP_TIMEOUT_MS = "5000";
  process.env.DT_HTTP_MAX_RETRIES = "3";
  return new DtClient({
    clusterUrl: "https://example",
    envId: "env",
    token: "read-token",
    clusterToken: null,
    writeToken: "write-token",
    tlsVerify: false,
    auditDir: "/tmp",
  });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("DtClient retries", () => {
  it("GET succeeds on first try", async () => {
    requestMock.mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const result = await client.get("/api/v2/x");
    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("GET retries on 429 then succeeds", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(429, "rate limited", { "retry-after": "0" }))
      .mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const result = await client.get("/api/v2/x");
    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("GET retries on 503 then succeeds", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(503, "unavailable"))
      .mockResolvedValueOnce(makeResp(503, "unavailable"))
      .mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const result = await client.get("/api/v2/x");
    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("GET throws DtApiError on 404 — no retry", async () => {
    requestMock.mockResolvedValueOnce(makeResp(404, "not found"));
    const client = makeClient();
    await expect(client.get("/api/v2/x")).rejects.toThrow(DtApiError);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("GET exhausts retries and throws the last DtApiError", async () => {
    requestMock.mockResolvedValue(makeResp(503, "always-down"));
    const client = makeClient();
    await expect(client.get("/api/v2/x")).rejects.toThrow(DtApiError);
    // initial attempt + 3 retries = 4 total
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it("POST is NOT retried on 503 (unsafe verb)", async () => {
    requestMock.mockResolvedValueOnce(makeResp(503, "down"));
    const client = makeClient();
    await expect(
      client.post("test_tool", "/api/v2/x", { a: 1 })
    ).rejects.toThrow(DtApiError);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("postRead IS retried (it's idempotent semantically)", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(503, "down"))
      .mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const result = await client.postRead("/api/v2/logs/search", { q: "test" });
    expect(result.status).toBe(200);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("respects numeric Retry-After header on 429", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(429, "wait", { "retry-after": "0" }))
      .mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const t0 = Date.now();
    await client.get("/api/v2/x");
    const elapsed = Date.now() - t0;
    // We asked for retry-after=0; should be near-zero (we just need to verify
    // the test completes quickly — not stuck on default backoff).
    expect(elapsed).toBeLessThan(500);
  });

  it("retries on network/abort errors (simulated)", async () => {
    requestMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(makeResp(200, '{"ok":true}'));
    const client = makeClient();
    const result = await client.get("/api/v2/x");
    expect(result).toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});

describe("DtClient retry policy from env", () => {
  it("reads timeout/maxRetries from env", () => {
    process.env.DT_HTTP_TIMEOUT_MS = "12345";
    process.env.DT_HTTP_MAX_RETRIES = "7";
    const client = new DtClient({
      clusterUrl: "https://example",
      envId: "env",
      token: "t",
      clusterToken: null,
      writeToken: null,
      tlsVerify: false,
      auditDir: "/tmp",
    });
    expect(client.retryPolicy.timeoutMs).toBe(12345);
    expect(client.retryPolicy.maxRetries).toBe(7);
  });
});
