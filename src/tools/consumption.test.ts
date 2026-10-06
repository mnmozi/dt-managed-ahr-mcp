import { describe, it, expect } from "vitest";
import { categorize } from "./consumption.js";

describe("categorize (billing metric → AHR cost category)", () => {
  it("routes DDU pools by key", () => {
    expect(categorize("builtin:billing.ddu.metrics.total")).toBe("dduMetrics");
    expect(categorize("builtin:billing.ddu.metrics.byEntity")).toBe("dduMetrics");
    expect(categorize("builtin:billing.ddu.log.total")).toBe("dduLogs");
    expect(categorize("builtin:billing.ddu.events.total")).toBe("dduEvents");
    expect(categorize("builtin:billing.ddu.traces.total")).toBe("dduTraces");
    expect(categorize("builtin:billing.ddu.serverless.total")).toBe("dduServerless");
  });
  it("routes host units, synthetic and sessions", () => {
    expect(categorize("builtin:billing.full_stack_monitoring.usage_per_host")).toBe("hostUnits");
    expect(categorize("builtin:billing.infrastructure_monitoring.usage")).toBe("hostUnits");
    expect(categorize("builtin:billing.synthetic.actions")).toBe("synthetic");
    expect(categorize("builtin:billing.usersession.user_session_count")).toBe("sessions");
  });
  it("falls back to other", () => {
    expect(categorize("builtin:billing.something.new")).toBe("other");
  });
});
