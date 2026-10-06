import { describe, it, expect } from "vitest";
import { billingFamily, discoverMetrics, isAggregateBillingMetric } from "./billing-metrics.js";
import type { DtClient } from "../dt-client.js";

describe("isAggregateBillingMetric", () => {
  it.each([
    ["builtin:billing.ddu.metrics.total", true],
    ["builtin:billing.full_stack_monitoring.usage_per_host", true],
    ["builtin:billing.full_stack_monitoring.usage_per_container", true],
    ["builtin:billing.synthetic.actions", true],
    ["builtin:billing.log.ingest.usage", true],
    ["builtin:billing.real_user_monitoring.web.session.usage", true],
    ["builtin:billing.ddu.metrics.byEntity", false],
    ["builtin:billing.ddu.metrics.byEntityRaw", false],
    ["builtin:billing.synthetic.actions.usage_by_browser_monitor", false],
    ["builtin:billing.apps.web.sessionsWithReplayByApplication", false],
    ["builtin:billing.hostunits", false],
    ["builtin:apps.web.sessionCount", false],
  ])("%s -> %s", (id, want) => {
    expect(isAggregateBillingMetric(id)).toBe(want);
  });
});

describe("billingFamily", () => {
  it("groups by the segment after builtin:billing.", () => {
    expect(billingFamily("builtin:billing.ddu.log.total")).toBe("ddu");
    expect(billingFamily("builtin:billing.full_stack_monitoring.usage_per_host")).toBe(
      "full_stack_monitoring"
    );
  });
});

describe("discoverMetrics", () => {
  it("follows nextPageKey and returns ids with metadata", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const client = {
      get: async (_path: string, opts?: { query?: Record<string, unknown> }) => {
        calls.push(opts?.query);
        if (opts?.query?.nextPageKey) {
          return { metrics: [{ metricId: "builtin:billing.b", unit: "Unspecified" }] };
        }
        return {
          metrics: [{ metricId: "builtin:billing.a", displayName: "A" }],
          nextPageKey: "k1",
        };
      },
    } as unknown as DtClient;

    const got = await discoverMetrics(client, "builtin:billing.*");

    expect(got.map((m) => m.metricId)).toEqual(["builtin:billing.a", "builtin:billing.b"]);
    expect(calls[0]?.metricSelector).toBe("builtin:billing.*");
    expect(calls[1]).toEqual({ nextPageKey: "k1" });
  });
});
