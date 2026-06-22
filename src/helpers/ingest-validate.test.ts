import { describe, it, expect } from "vitest";
import {
  validateMetricPoints,
  validateLogRecords,
  validateBizevents,
} from "./ingest-validate.js";

describe("validateMetricPoints", () => {
  it("accepts well-formed structured points", () => {
    const r = validateMetricPoints([
      { metricKey: "my.metric", value: 1.5 },
      { metricKey: "my.metric", dimensions: { host: "h1" }, value: "gauge,2.0", timestampMs: Date.now() },
    ]);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects a metric key that starts with a digit", () => {
    const r = validateMetricPoints([{ metricKey: "1bad", value: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.field).toBe("metricKey");
  });

  it("rejects non-finite numeric values", () => {
    const r = validateMetricPoints([{ metricKey: "ok", value: Number.POSITIVE_INFINITY }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.field).toBe("value");
  });

  it("rejects empty dimension key", () => {
    const r = validateMetricPoints([
      { metricKey: "ok", dimensions: { "": "v" }, value: 1 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects more than 50 dimensions", () => {
    const dims: Record<string, string> = {};
    for (let i = 0; i < 60; i++) dims[`d${i}`] = "v";
    const r = validateMetricPoints([{ metricKey: "ok", dimensions: dims, value: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/too many dimensions/);
  });

  it("warns when timestampMs looks like seconds", () => {
    const r = validateMetricPoints([{ metricKey: "ok", value: 1, timestampMs: 1_700_000_000 }]);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]!.message).toMatch(/looks like seconds/);
  });

  it("rejects negative timestampMs", () => {
    const r = validateMetricPoints([{ metricKey: "ok", value: 1, timestampMs: -5 }]);
    expect(r.ok).toBe(false);
  });
});

describe("validateLogRecords", () => {
  it("accepts well-formed records", () => {
    const r = validateLogRecords([
      { content: "hello", severity: "INFO" },
      { content: "bye", timestamp: Date.now() },
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects missing content", () => {
    const r = validateLogRecords([{ severity: "INFO" }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.field).toBe("content");
  });

  it("rejects bad timestamp type", () => {
    const r = validateLogRecords([{ content: "x", timestamp: true as unknown as string }]);
    expect(r.ok).toBe(false);
  });

  it("warns on unrecognized severity", () => {
    const r = validateLogRecords([{ content: "x", severity: "BANANA" }]);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]!.field).toBe("severity");
  });

  it("warns on oversized record", () => {
    const big = "x".repeat(10_000);
    const r = validateLogRecords([{ content: big }]);
    expect(r.warnings.some((w) => /exceeds soft cap/.test(w.message))).toBe(true);
  });
});

describe("validateBizevents", () => {
  it("accepts default-encoding events with event.type + event.provider (flat)", () => {
    const r = validateBizevents([{ "event.type": "order", "event.provider": "shop" }]);
    expect(r.ok).toBe(true);
  });

  it("accepts default-encoding with nested event object", () => {
    const r = validateBizevents([{ event: { type: "order", provider: "shop" } }]);
    expect(r.ok).toBe(true);
  });

  it("rejects default-encoding missing event.provider", () => {
    const r = validateBizevents([{ "event.type": "x" }]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "event.provider")).toBe(true);
  });

  it("accepts CloudEvents with all required fields", () => {
    const r = validateBizevents(
      [{ id: "1", source: "s", type: "t", specversion: "1.0", data: {} }],
      "cloudevent"
    );
    expect(r.ok).toBe(true);
  });

  it("rejects CloudEvents missing specversion", () => {
    const r = validateBizevents(
      [{ id: "1", source: "s", type: "t" }],
      "cloudevent"
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "specversion")).toBe(true);
  });

  it("warns when CloudEvents data is missing", () => {
    const r = validateBizevents(
      [{ id: "1", source: "s", type: "t", specversion: "1.0" }],
      "cloudevent"
    );
    expect(r.ok).toBe(true);
    expect(r.warnings[0]!.field).toBe("data");
  });
});
