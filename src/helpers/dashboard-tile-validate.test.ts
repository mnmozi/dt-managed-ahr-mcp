import { describe, it, expect } from "vitest";
import { validateDashboardTiles, levenshtein } from "./dashboard-tile-validate.js";

describe("levenshtein", () => {
  it("0 for equal strings", () => {
    expect(levenshtein("DATA_EXPLORER", "DATA_EXPLORER")).toBe(0);
  });
  it("1 for single missing char", () => {
    expect(levenshtein("DATA_EXPLORE", "DATA_EXPLORER")).toBe(1);
  });
  it("equal to longer string length when one is empty", () => {
    expect(levenshtein("", "ABC")).toBe(3);
    expect(levenshtein("XYZ", "")).toBe(3);
  });
});

describe("validateDashboardTiles", () => {
  it("ok=true when dashboard has no tiles", () => {
    const r = validateDashboardTiles({ tiles: [] });
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("ok=true when dashboard isn't an object", () => {
    expect(validateDashboardTiles(null).ok).toBe(true);
    expect(validateDashboardTiles("nope").ok).toBe(true);
  });

  it("catches DATA_EXPLORE typo and suggests DATA_EXPLORER", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "DATA_EXPLORE", queries: [{ metric: "foo" }] }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.severity).toBe("error");
    expect(r.issues[0]!.message).toMatch(/did you mean 'DATA_EXPLORER'/);
  });

  it("DATA_EXPLORER with queries passes", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "DATA_EXPLORER", queries: [{ metric: "builtin:host.cpu.usage" }] }],
    });
    expect(r.ok).toBe(true);
  });

  it("DATA_EXPLORER without queries or customChartingItems fails", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "DATA_EXPLORER" }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/requires at least one of/);
  });

  it("MARKDOWN without markdown text fails", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "MARKDOWN" }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/markdown/);
  });

  it("MARKDOWN with markdown text passes", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "MARKDOWN", markdown: "# hello" }],
    });
    expect(r.ok).toBe(true);
  });

  it("missing tileType is an error", () => {
    const r = validateDashboardTiles({ tiles: [{ markdown: "x" }] });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.field).toBe("tileType");
  });

  it("totally-unknown tileType (no near-match) is a warning, not an error", () => {
    const r = validateDashboardTiles({
      tiles: [{ tileType: "ZZZZZZZZZZZZZZZ_UNKNOWN_PROBABLY_INTERNAL" }],
    });
    expect(r.ok).toBe(true); // warnings don't flip ok
    expect(r.issues[0]!.severity).toBe("warning");
  });

  it("aggregates counts by type", () => {
    const r = validateDashboardTiles({
      tiles: [
        { tileType: "HEADER" },
        { tileType: "HEADER" },
        { tileType: "MARKDOWN", markdown: "x" },
      ],
    });
    expect(r.countsByType).toEqual({ HEADER: 2, MARKDOWN: 1 });
  });
});
