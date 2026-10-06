import { describe, it, expect } from "vitest";
import { isPlatformTech } from "./oneagent-modules.js";

describe("isPlatformTech", () => {
  it("excludes platforms that have no code module of their own", () => {
    expect(isPlatformTech("KUBERNETES")).toBe(true);
    expect(isPlatformTech("cri-o")).toBe(true);
  });

  it("keeps deep-monitorable runtimes", () => {
    expect(isPlatformTech("JAVA")).toBe(false);
    expect(isPlatformTech("NODE_JS")).toBe(false);
  });
});
