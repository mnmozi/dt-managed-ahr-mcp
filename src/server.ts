#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { DtClient } from "./dt-client.js";
import { AuditLog } from "./audit.js";

import { registerCoreReads } from "./register/reads-core.js";
import { registerInfraReads } from "./register/reads-infra.js";
import { registerObservabilityReads } from "./register/reads-observability.js";
import { registerSchemaWrappers } from "./register/reads-schema-wrappers.js";
import { registerClusterReadTools } from "./register/reads-cluster.js";
import { registerWrites } from "./register/writes.js";
import { registerSpecResources } from "./resources/specs.js";
import { registerAhrPrompt } from "./prompts/ahr.js";
import { makeLogger } from "./logger.js";

const lifecycleLog = makeLogger("lifecycle");

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + "\n");
      process.exit(2);
    }
    throw err;
  }

  const client = new DtClient(cfg);
  const server = new McpServer(
    { name: "dt-managed-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // ---------- read surface (always on) ----------
  registerCoreReads(server, client, cfg);
  registerInfraReads(server, client);
  registerObservabilityReads(server, client);
  registerSchemaWrappers(server, client);
  registerClusterReadTools(server, client);

  // ---------- write surface (gated on DT_WRITE_TOKEN) ----------
  if (client.writeEnabled) {
    lifecycleLog.info("write mode ENABLED", {
      clusterUrl: cfg.clusterUrl,
      envId: cfg.envId,
      auditDir: cfg.auditDir,
    });
    const audit = new AuditLog(cfg.auditDir);
    registerWrites(server, client, audit);
  } else {
    lifecycleLog.info("read-only mode (DT_WRITE_TOKEN not set; write tools will not be registered)");
  }

  // ---------- specs + prompts ----------
  registerSpecResources(server, client, cfg);
  registerAhrPrompt(server);

  // ---------- transport + lifecycle ----------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  lifecycleLog.error("fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
