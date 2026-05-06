#!/usr/bin/env tsx
// Smoke test: exercises the Dt client against the configured cluster without starting the MCP transport.
// Usage (choose one token form):
//   DT_CLUSTER_URL=... DT_ENV_ID=... DT_TOKEN_FILE=... DT_TLS_VERIFY=0 npm run smoke
//   DT_CLUSTER_URL=... DT_ENV_ID=... DT_TOKEN=dt0c01...  DT_TLS_VERIFY=0 npm run smoke

import { loadConfig } from "../src/config.js";
import { DtClient, DtApiError } from "../src/dt-client.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new DtClient(cfg);

  console.log(`[smoke] cluster: ${cfg.clusterUrl}`);
  console.log(`[smoke] env:     ${cfg.envId}`);
  console.log(`[smoke] tls:     ${cfg.tlsVerify ? "verify" : "SKIP (self-signed ok)"}`);
  console.log();

  try {
    console.log("[smoke] GET /api/v2/settings/schemas");
    const data = await client.get<{ totalCount?: number; items?: Array<{ schemaId?: string }> }>(
      "/api/v2/settings/schemas"
    );
    const items = data.items ?? [];
    console.log(`[smoke] OK — ${items.length} schemas returned (totalCount=${data.totalCount ?? "?"})`);
    const preview = items.slice(0, 5).map((it) => it.schemaId).filter(Boolean);
    if (preview.length) console.log(`[smoke] first few: ${preview.join(", ")}`);

    const hasAutoTags = items.some((it) => it.schemaId === "builtin:tags.auto-tagging");
    const hasMZ = items.some((it) => it.schemaId === "builtin:management-zones");
    console.log(`[smoke] builtin:tags.auto-tagging present: ${hasAutoTags}`);
    console.log(`[smoke] builtin:management-zones present:  ${hasMZ}`);
    if (!hasAutoTags || !hasMZ) {
      console.log("[smoke] WARN: expected AHR schemas missing — token scope may be insufficient or cluster lacks the schema.");
    }
  } catch (err) {
    if (err instanceof DtApiError) {
      console.error(`[smoke] FAIL: HTTP ${err.status} on ${err.path}`);
      console.error(`[smoke] body: ${err.body.slice(0, 800)}`);
      if (err.status === 401) console.error("[smoke] hint: token invalid or not read correctly");
      if (err.status === 403) console.error("[smoke] hint: token missing ReadConfig scope (or Settings read scope)");
      process.exit(1);
    }
    throw err;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`[smoke] unexpected error: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
