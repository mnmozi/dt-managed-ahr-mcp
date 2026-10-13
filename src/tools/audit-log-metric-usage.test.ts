import { describe, it, expect } from "vitest";
import { registerAuditLogMetricUsage } from "./audit-log-metric-usage.js";
import { registerObservabilityReads } from "../register/reads-observability.js";
import { DtApiError, type DtClient } from "../dt-client.js";

type Args = { from?: string; to?: string; graceDays?: number; maxDashboards?: number };
type Handler = (args: Args) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
type Query = Record<string, unknown>;

function captureTools(): { server: { registerTool: (...a: unknown[]) => void }; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: unknown, _cfg: unknown, h: unknown) => {
      tools.set(name as string, h as Handler);
    },
  };
  return { server, tools };
}

/** Records every GET so tests can assert on what the tool asked the API for. */
function fakeClient(routes: Record<string, (q?: Query) => unknown>): { client: DtClient; calls: Array<{ path: string; query?: Query }> } {
  const calls: Array<{ path: string; query?: Query }> = [];
  const client = {
    get: async (path: string, opts?: { query?: Query }) => {
      calls.push({ path, query: opts?.query });
      const handler = routes[path];
      if (!handler) throw new DtApiError(404, "GET", path, "no such route in fake");
      return handler(opts?.query);
    },
  } as unknown as DtClient;
  return { client, calls };
}

const routes: Record<string, (q?: Query) => unknown> = {
  "/api/v2/settings/objects": (q) =>
    q?.schemaIds === "builtin:logmonitoring.schemaless-log-metric"
      ? { items: [{ objectId: "<object-id-1>", value: { enabled: true, key: "log.logins" }, created: 0 }] }
      : { items: [] },
  "/api/v2/slo": () => ({ slo: [] }),
  "/api/config/v1/dashboards": () => ({ dashboards: [{ id: "<dashboard-id>", name: "shop-app overview" }] }),
  "/api/config/v1/dashboards/%3Cdashboard-id%3E": () => ({ tiles: [] }),
  "/api/v2/metrics/query": (q) => ({ result: [{ metricId: String(q?.metricSelector), data: [{ values: [3] }] }] }),
};

function setup() {
  const { server, tools } = captureTools();
  const { client, calls } = fakeClient(routes);
  registerAuditLogMetricUsage(server as never, client);
  const handler = tools.get("dt_audit_log_metric_usage");
  if (!handler) throw new Error("dt_audit_log_metric_usage not registered");
  return { handler, calls };
}

describe("dt_audit_log_metric_usage", () => {
  it("is part of the observability read surface", () => {
    const { server, tools } = captureTools();
    registerObservabilityReads(server as never, fakeClient({}).client);
    expect(tools.has("dt_audit_log_metric_usage")).toBe(true);
  });

  it("applies defaults: 30-day window, 14-day grace", async () => {
    const { handler, calls } = setup();
    const res = await handler({});
    const report = JSON.parse(res.content[0]!.text);

    const metricQuery = calls.find((c) => c.path === "/api/v2/metrics/query");
    expect(metricQuery?.query).toMatchObject({ from: "now-30d", to: "now", resolution: "Inf" });
    expect(report.window).toEqual({ from: "now-30d", to: "now" });
    expect(report.graceDays).toBe(14);
    expect(res.isError).toBeUndefined();
  });

  it("passes overrides through", async () => {
    const { handler, calls } = setup();
    const res = await handler({ from: "now-7d", to: "now-1d", graceDays: 3, maxDashboards: 0 });
    const report = JSON.parse(res.content[0]!.text);

    expect(calls.find((c) => c.path === "/api/v2/metrics/query")?.query).toMatchObject({ from: "now-7d", to: "now-1d" });
    expect(report.graceDays).toBe(3);
    expect(calls.some((c) => c.path.startsWith("/api/config/v1/dashboards/"))).toBe(false);
    expect(report.coverage.dashboards.truncated).toBe(true);
  });

  it("returns one JSON text payload with summary and findings", async () => {
    const { handler } = setup();
    const res = await handler({});
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.type).toBe("text");
    const report = JSON.parse(res.content[0]!.text);
    expect(report.summary).toMatchObject({ total: 1, orphan: 1 });
    expect(report.findings[0]).toMatchObject({ key: "log.logins", bucket: "orphan", dataStatus: "has_data" });
    expect(report.blindSpots.length).toBeGreaterThan(0);
  });
});
