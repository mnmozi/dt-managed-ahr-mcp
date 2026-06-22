/**
 * Lazily-spawned, process-lifetime engine MCP client.
 *
 * Multiple MCP tools (dt_run_checks, dt_get_oneagent_versions, future
 * delegating tools) all want one engine subprocess, not one per call. This
 * module owns the singleton.
 *
 * Binary resolution: DT_ENGINE_BIN env var if set, else fall back to looking
 * for `dt-engine` on PATH. The spawn fails with a clear error if not found.
 */
import { EngineClient } from "./engine-client.js";

let engineClient: EngineClient | null = null;
let enginePromise: Promise<EngineClient> | null = null;

export async function getEngine(): Promise<EngineClient> {
  if (engineClient) return engineClient;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const binPath = process.env.DT_ENGINE_BIN?.trim() || "dt-engine";
    const c = new EngineClient(binPath);
    await c.start();
    engineClient = c;
    return c;
  })();
  return enginePromise;
}

/** Best-effort shutdown. Called on MCP server shutdown. */
export async function stopEngine(): Promise<void> {
  if (engineClient) {
    await engineClient.stop();
    engineClient = null;
    enginePromise = null;
  }
}
