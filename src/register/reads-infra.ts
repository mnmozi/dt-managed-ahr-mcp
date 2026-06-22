import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";

import { registerOneAgentVersions } from "../tools/oneagent-versions.js";
import { registerOneAgentModuleStatus } from "../tools/oneagent-modules.js";
import { registerActiveGateVersions } from "../tools/activegate-versions.js";
import { registerMaintenanceWindows } from "../tools/maintenance-windows.js";
import { registerExtensions } from "../tools/extensions.js";
import { registerSyntheticMonitors } from "../tools/synthetic-monitors.js";
import { registerEntityOrphans } from "../tools/entity-orphans.js";
import { registerOrphanScopes } from "../tools/orphan-scopes.js";
import { registerRecentlyChanged } from "../tools/recently-changed.js";

/** Infrastructure reads: OneAgent, ActiveGate, maintenance, extensions, orphans. */
export function registerInfraReads(server: McpServer, client: DtClient): void {
  registerOneAgentVersions(server, client);
  registerOneAgentModuleStatus(server, client);
  registerActiveGateVersions(server, client);
  registerMaintenanceWindows(server, client);
  registerExtensions(server, client);
  registerSyntheticMonitors(server, client);
  registerEntityOrphans(server, client);
  registerOrphanScopes(server, client);
  registerRecentlyChanged(server, client);
}
