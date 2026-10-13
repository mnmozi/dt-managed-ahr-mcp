import { describe, it, expect } from "vitest";
import {
  auditLogMetricUsage,
  classify,
  collectStrings,
  fetchDataStatus,
  normalizeLogMetricKey,
  referencesKey,
  type Consumer,
  type LogMetricRule,
} from "./log-metric-usage.js";
import { DtApiError, type DtClient } from "../dt-client.js";

type Query = Record<string, unknown>;

function clientWith(routes: Record<string, (q?: Query) => unknown>): DtClient {
  return {
    get: async (path: string, opts?: { query?: Query }) => {
      const handler = routes[path];
      if (!handler) throw new DtApiError(404, "GET", path, "HTTP 404 Not Found");
      return handler(opts?.query);
    },
  } as unknown as DtClient;
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13);

function rule(key: string, extra: Partial<LogMetricRule> = {}): LogMetricRule {
  return { key, objectId: `<object-id-${key}>`, schemaId: "builtin:logmonitoring.schemaless-log-metric", enabled: true, created: NOW - 90 * DAY, ...extra };
}

function consumer(type: Consumer["type"], texts: string[], enabled = true): Consumer {
  return { type, id: `<${type}-id>`, name: `${type} consumer`, enabled, texts };
}

describe("referencesKey", () => {
  it("finds every key in an arithmetic SLO expression, not just the first", () => {
    const expr = "(100)*(log.checkout.ok:splitBy())/(log.checkout.total:splitBy())";
    expect(referencesKey(expr, "log.checkout.ok")).toBe(true);
    expect(referencesKey(expr, "log.checkout.total")).toBe(true);
  });

  it("does not match a key that is a prefix of another key", () => {
    expect(referencesKey("log.errors_total:splitBy()", "log.errors")).toBe(false);
    expect(referencesKey("log.errors.payments", "log.errors")).toBe(false);
  });

  it("matches with transforms, inside quotes and case-insensitively", () => {
    expect(referencesKey("log.errors:filter(eq(\"dt.entity.host\",\"HOST-0000000000000001\")):sum", "log.errors")).toBe(true);
    expect(referencesKey('"log.Errors"', "log.errors")).toBe(true);
  });
});

describe("normalizeLogMetricKey", () => {
  it("adds the log. prefix only when missing", () => {
    expect(normalizeLogMetricKey("log.logins")).toBe("log.logins");
    expect(normalizeLogMetricKey("logins")).toBe("log.logins");
  });
});

describe("collectStrings", () => {
  it("walks nested tiles and skips prose fields", () => {
    const tiles = [
      { tileType: "MARKDOWN", markdown: "see log.logins" },
      { tileType: "DATA_EXPLORER", name: "log.notes", queries: [{ metricSelector: "log.logins:splitBy()" }] },
    ];
    const strings = collectStrings(tiles, new Set(["markdown", "name"]));
    expect(strings).toContain("log.logins:splitBy()");
    expect(strings.join(" ")).not.toContain("see log.logins");
    expect(strings).not.toContain("log.notes");
  });
});

describe("classify", () => {
  const opts = { now: NOW, graceDays: 14 };

  it("used: consumer + data", () => {
    const f = classify(rule("log.logins"), [consumer("slo", ["log.logins"])], "has_data", opts);
    expect(f.bucket).toBe("used");
    expect(f.activeConsumers).toHaveLength(1);
  });

  it("broken: consumer but no data, or metric never registered", () => {
    expect(classify(rule("log.logins"), [consumer("metric_event", ["log.logins"])], "no_data", opts).bucket).toBe("broken");
    expect(classify(rule("log.logins"), [consumer("metric_event", ["log.logins"])], "not_registered", opts).bucket).toBe("broken");
  });

  it("broken: consumer but the extraction rule is disabled", () => {
    const f = classify(rule("log.logins", { enabled: false }), [consumer("dashboard", ["log.logins"])], "has_data", opts);
    expect(f.bucket).toBe("broken");
    expect(f.reason).toMatch(/disabled/);
  });

  it("orphan: data but no consumer", () => {
    expect(classify(rule("log.logins"), [consumer("slo", ["log.other"])], "has_data", opts).bucket).toBe("orphan");
  });

  it("dead: no consumer, no data", () => {
    expect(classify(rule("log.logins"), [], "no_data", opts).bucket).toBe("dead");
  });

  it("a disabled consumer does not count as usage", () => {
    const f = classify(rule("log.logins"), [consumer("metric_event", ["log.logins"], false)], "has_data", opts);
    expect(f.bucket).toBe("orphan");
    expect(f.disabledConsumers).toHaveLength(1);
    expect(f.reason).toMatch(/disabled metric events/);
  });

  it("recent: unconsumed rules inside the grace period", () => {
    expect(classify(rule("log.logins", { created: NOW - 3 * DAY }), [], "no_data", opts).bucket).toBe("recent");
  });

  it("no created time means no grace period", () => {
    expect(classify(rule("log.logins", { created: undefined }), [], "no_data", opts).bucket).toBe("dead");
  });

  it("inconclusive: no consumer and data unknown", () => {
    expect(classify(rule("log.logins"), [], "unknown", opts).bucket).toBe("inconclusive");
  });
});

describe("fetchDataStatus", () => {
  it("isolates an unregistered key when the batch 404s", async () => {
    const client = clientWith({
      "/api/v2/metrics/query": (q) => {
        const sel = String(q?.metricSelector);
        if (sel.includes("log.missing")) throw new DtApiError(404, "GET", "/api/v2/metrics/query", "not found");
        return { result: [{ metricId: sel, data: sel.startsWith("log.busy") ? [{ values: [42] }] : [{ values: [null] }] }] };
      },
    });
    const out = await fetchDataStatus(client, ["log.busy", "log.quiet", "log.missing"], { from: "now-30d", to: "now" });
    expect(out.get("log.busy")).toBe("has_data");
    expect(out.get("log.quiet")).toBe("no_data");
    expect(out.get("log.missing")).toBe("not_registered");
  });
});

describe("auditLogMetricUsage", () => {
  const settings = (q?: Query) => {
    switch (q?.schemaIds) {
      case "builtin:logmonitoring.schemaless-log-metric":
        return {
          items: [
            { objectId: "<object-id-1>", value: { enabled: true, key: "log.checkout.ok" }, created: NOW - 90 * DAY },
            { objectId: "<object-id-2>", value: { enabled: true, key: "log.checkout.total" }, created: NOW - 90 * DAY },
            { objectId: "<object-id-3>", value: { enabled: true, key: "log.logins" }, created: NOW - 90 * DAY },
            { objectId: "<object-id-4>", value: { enabled: true, key: "log.payments.errors" }, created: NOW - 90 * DAY },
            { objectId: "<object-id-5>", value: { enabled: true, key: "log.legacy" }, created: NOW - 90 * DAY },
          ],
        };
      case "builtin:anomaly-detection.metric-events":
        return {
          items: [
            {
              objectId: "<object-id-me>",
              value: { enabled: true, summary: "payments errors", queryDefinition: { type: "METRIC_KEY", metricKey: "log.payments.errors" } },
            },
          ],
        };
      default:
        throw new DtApiError(404, "GET", "/api/v2/settings/objects", "schema not found");
    }
  };

  const baseRoutes = {
    "/api/v2/settings/objects": settings,
    "/api/v2/slo": () => ({
      slo: [{ id: "<slo-id>", name: "checkout success", enabled: true, metricExpression: "(100)*(log.checkout.ok)/(log.checkout.total)" }],
    }),
    "/api/config/v1/dashboards": () => ({ dashboards: [{ id: "<dashboard-id>", name: "shop-app overview" }] }),
    "/api/config/v1/dashboards/%3Cdashboard-id%3E": () => ({
      tiles: [
        { tileType: "MARKDOWN", markdown: "log.legacy is deprecated" },
        { tileType: "DATA_EXPLORER", queries: [{ metric: "log.checkout.ok" }] },
      ],
    }),
    "/api/v2/metrics/log.payments.errors": () => ({ metricId: "log.payments.errors", lastWritten: Date.UTC(2026, 6, 29) }),
    "/api/v2/metrics/log.legacy": () => ({ metricId: "log.legacy", lastWritten: null }),
    "/api/v2/metrics/query": (q?: Query) => {
      const sels = String(q?.metricSelector).split(",");
      const quiet = new Set(["log.payments.errors:splitBy()", "log.legacy:splitBy()"]);
      return { result: sels.map((s) => ({ metricId: s, data: [{ values: [quiet.has(s) ? null : 7] }] })) };
    },
  };

  it("buckets every rule against all three consumer types", async () => {
    const report = await auditLogMetricUsage(clientWith(baseRoutes), {
      from: "now-30d",
      to: "now",
      graceDays: 14,
      maxDashboards: 100,
      now: NOW,
    });
    const byKey = Object.fromEntries(report.findings.map((f) => [f.key, f]));
    expect(byKey["log.checkout.ok"].bucket).toBe("used");
    expect(byKey["log.checkout.ok"].activeConsumers.map((c) => c.type).sort()).toEqual(["dashboard", "slo"]);
    expect(byKey["log.checkout.total"].bucket).toBe("used"); // only via the SLO denominator
    expect(byKey["log.payments.errors"].bucket).toBe("broken");
    expect(byKey["log.logins"].bucket).toBe("orphan");
    expect(byKey["log.legacy"].bucket).toBe("dead"); // markdown mention is not a consumer
    expect(byKey["log.payments.errors"].lastWritten).toBe("2026-07-29T00:00:00.000Z");
    expect(byKey["log.legacy"].lastWritten).toBe("never");
    expect(byKey["log.logins"].lastWritten).toBeUndefined(); // has data, not looked up
    expect(report.summary).toMatchObject({ total: 5, used: 2, broken: 1, orphan: 1, dead: 1 });
    expect(report.findings[0].bucket).toBe("broken"); // worst first
    expect(report.conclusive).toBe(true);
    expect(report.coverage.rules["builtin:logmonitoring.metric-extraction"].ok).toBe(false);
  });

  it("is not conclusive when a consumer source fails", async () => {
    const routes = {
      ...baseRoutes,
      "/api/v2/slo": () => {
        throw new DtApiError(403, "GET", "/api/v2/slo", "missing slo.read");
      },
    };
    const report = await auditLogMetricUsage(clientWith(routes), {
      from: "now-30d",
      to: "now",
      graceDays: 14,
      maxDashboards: 100,
      now: NOW,
    });
    expect(report.conclusive).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/SLOs could not be read/);
    expect(report.findings.find((f) => f.key === "log.checkout.total")?.bucket).toBe("orphan");
  });

  it("falls back when `created` is rejected in fields", async () => {
    const routes = {
      ...baseRoutes,
      "/api/v2/settings/objects": (q?: Query) => {
        if (String(q?.fields).includes("created")) throw new DtApiError(400, "GET", "/api/v2/settings/objects", "bad field");
        return settings(q);
      },
    };
    const report = await auditLogMetricUsage(clientWith(routes), {
      from: "now-30d",
      to: "now",
      graceDays: 14,
      maxDashboards: 100,
      now: NOW,
    });
    expect(report.summary.total).toBe(5);
  });

  it("reports dashboard truncation", async () => {
    const report = await auditLogMetricUsage(clientWith(baseRoutes), {
      from: "now-30d",
      to: "now",
      graceDays: 14,
      maxDashboards: 0,
      now: NOW,
    });
    expect(report.coverage.dashboards.truncated).toBe(true);
    expect(report.conclusive).toBe(false);
  });
});
