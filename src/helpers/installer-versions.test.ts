import { describe, it, expect } from "vitest";
import { pickLatestVersion, toInstallerOsType } from "./installer-versions.js";

describe("toInstallerOsType", () => {
  it("maps inventory LINUX to the Deployment API 'unix' segment", () => {
    expect(toInstallerOsType("LINUX", "agent")).toBe("unix");
    expect(toInstallerOsType("LINUX", "gateway")).toBe("unix");
    expect(toInstallerOsType("linux", "agent")).toBe("unix");
  });
  it("keeps windows / aix / solaris / zos for OneAgent", () => {
    expect(toInstallerOsType("WINDOWS", "agent")).toBe("windows");
    expect(toInstallerOsType("AIX", "agent")).toBe("aix");
    expect(toInstallerOsType("SOLARIS", "agent")).toBe("solaris");
    expect(toInstallerOsType("ZOS", "agent")).toBe("zos");
  });
  it("ActiveGate only has windows + unix installers", () => {
    expect(toInstallerOsType("AIX", "gateway")).toBeNull();
    expect(toInstallerOsType("WINDOWS", "gateway")).toBe("windows");
  });
  it("returns null for OSes without an installer and for empty input", () => {
    expect(toInstallerOsType("DARWIN", "agent")).toBeNull();
    expect(toInstallerOsType("HPUX", "agent")).toBeNull();
    expect(toInstallerOsType("", "agent")).toBeNull();
  });
  it("tolerates family-suffixed variants", () => {
    expect(toInstallerOsType("WINDOWS_SERVER", "agent")).toBe("windows");
    expect(toInstallerOsType("LINUX_X86", "gateway")).toBe("unix");
  });
});

describe("pickLatestVersion", () => {
  it("compares version segments numerically, not lexically", () => {
    expect(pickLatestVersion(["1.299.10.20250101-120000", "1.301.2.20250301-000000", "1.30.0"])).toBe(
      "1.301.2.20250301-000000"
    );
  });
  it("does not rely on input order", () => {
    expect(pickLatestVersion(["1.302.0", "1.290.0", "1.301.0"])).toBe("1.302.0");
  });
  it("ignores non-string / empty entries and returns undefined for nothing usable", () => {
    expect(pickLatestVersion([null, 42, ""])).toBeUndefined();
    expect(pickLatestVersion([])).toBeUndefined();
  });
});
