import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { makeLogger, setLogLevel } from "./logger.js";

/**
 * Logger tests. We capture stderr output by intercepting process.stderr.write
 * during the test, parse each line as JSON, and assert on the shape.
 */

let captured: string[] = [];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  captured = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  // Vitest's vi.spyOn would also work, but a manual replacement gives us
  // tighter control over the captured strings.
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  setLogLevel("info");
});

function parseRecords(): Array<Record<string, unknown>> {
  return captured
    .join("")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe("logger", () => {
  it("emits JSONL with required fields", () => {
    const log = makeLogger("test");
    log.info("hello", { foo: "bar" });
    const records = parseRecords();
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec).toMatchObject({
      level: "info",
      source: "test",
      msg: "hello",
      foo: "bar",
    });
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("filters by level", () => {
    setLogLevel("warn");
    const log = makeLogger("test");
    log.debug("debug-msg");
    log.info("info-msg");
    log.warn("warn-msg");
    log.error("error-msg");
    const records = parseRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.level).toBe("warn");
    expect(records[1]!.level).toBe("error");
  });

  it("child logger inherits static fields", () => {
    const log = makeLogger("test").child({ requestId: "abc" });
    log.info("hello");
    const rec = parseRecords()[0]!;
    expect(rec).toMatchObject({ source: "test", msg: "hello", requestId: "abc" });
  });

  it("per-call fields override child static fields", () => {
    const log = makeLogger("test").child({ requestId: "abc" });
    log.info("hello", { requestId: "xyz" });
    const rec = parseRecords()[0]!;
    expect(rec.requestId).toBe("xyz");
  });

  it("trace level visible when DT_LOG_LEVEL is trace", () => {
    setLogLevel("trace");
    const log = makeLogger("test");
    log.trace("trace-msg");
    const rec = parseRecords()[0]!;
    expect(rec.level).toBe("trace");
  });
});
