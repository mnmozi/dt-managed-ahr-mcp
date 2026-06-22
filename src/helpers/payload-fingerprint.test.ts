import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.js";
import {
  canonicalJSON,
  fingerprintOf,
  checkDuplicatePayload,
  DUPLICATE_WINDOW_MS,
} from "./payload-fingerprint.js";
import { setLogLevel } from "../logger.js";

setLogLevel("error");

let tmpDir = "";
let audit: AuditLog;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fingerprint-test-"));
  audit = new AuditLog(tmpDir);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("canonicalJSON", () => {
  it("sorts object keys for stable hash input", () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });

  it("preserves array order (semantically meaningful)", () => {
    expect(canonicalJSON([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalJSON([3, 2, 1])).not.toBe(canonicalJSON([1, 2, 3]));
  });

  it("recurses into nested objects", () => {
    const a = { outer: { b: 2, a: 1 } };
    const b = { outer: { a: 1, b: 2 } };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("fingerprintOf", () => {
  it("is stable across key reorderings", () => {
    expect(fingerprintOf({ x: 1, y: 2 })).toBe(fingerprintOf({ y: 2, x: 1 }));
  });

  it("changes when values change", () => {
    expect(fingerprintOf({ x: 1 })).not.toBe(fingerprintOf({ x: 2 }));
  });

  it("is 16 hex chars", () => {
    expect(fingerprintOf({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("checkDuplicatePayload", () => {
  it("first call is never a duplicate", () => {
    const r = checkDuplicatePayload(audit, "dt_create_settings", { foo: "bar" });
    expect(r.isDuplicate).toBe(false);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("detects an identical payload within the window", () => {
    const payload = { schemaId: "x", value: { name: "y" } };
    const first = checkDuplicatePayload(audit, "dt_create_settings", payload);
    audit.write({
      timestamp: new Date().toISOString(),
      tool: "dt_create_settings",
      method: "POST",
      path: "/api/v2/settings/objects",
      validateOnly: false,
      status: 200,
      payloadFingerprint: first.fingerprint,
    });
    const second = checkDuplicatePayload(audit, "dt_create_settings", payload);
    expect(second.isDuplicate).toBe(true);
    expect(second.priorRecord?.payloadFingerprint).toBe(first.fingerprint);
    expect(second.warning).toMatch(/identical payload/);
  });

  it("ignores duplicates outside the window", () => {
    const payload = { foo: "bar" };
    const fp = fingerprintOf(payload);
    const longAgo = new Date(Date.now() - DUPLICATE_WINDOW_MS - 1000).toISOString();
    audit.write({
      timestamp: longAgo,
      tool: "dt_create_settings",
      method: "POST",
      path: "/x",
      validateOnly: false,
      status: 200,
      payloadFingerprint: fp,
    });
    const r = checkDuplicatePayload(audit, "dt_create_settings", payload);
    expect(r.isDuplicate).toBe(false);
  });

  it("ignores duplicates from a different tool", () => {
    const payload = { foo: "bar" };
    const fp = fingerprintOf(payload);
    audit.write({
      timestamp: new Date().toISOString(),
      tool: "dt_create_dashboard",
      method: "POST",
      path: "/x",
      validateOnly: false,
      status: 200,
      payloadFingerprint: fp,
    });
    const r = checkDuplicatePayload(audit, "dt_create_settings", payload);
    expect(r.isDuplicate).toBe(false);
  });
});
