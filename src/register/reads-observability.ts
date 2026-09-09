import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";

import { registerConsumption } from "../tools/consumption.js";
import { registerCalculatedServiceMetrics } from "../tools/calculated-service-metrics.js";
import { registerServiceRequestCardinality } from "../tools/service-request-cardinality.js";
import { registerAuditLog } from "../tools/audit-log.js";
import { registerDashboards } from "../tools/dashboards.js";
import { registerApiTokens } from "../tools/api-tokens.js";
import { registerOauthClients } from "../tools/oauth-clients.js";
import { registerProblemHistory } from "../tools/problem-history.js";
import { registerRumAppInventory } from "../tools/rum-app-inventory.js";
import { registerRumAppFeatureMatrix } from "../tools/rum-app-feature-matrix.js";
import { registerListMetrics } from "../tools/list-metrics.js";
import { registerGetMetricMetadata } from "../tools/get-metric-metadata.js";
import { registerGetDashboardContext } from "../tools/get-dashboard-context.js";
import { registerSearchLogs } from "../tools/search-logs.js";
import { registerQueryMetrics } from "../tools/query-metrics.js";
import { registerSearchEntities } from "../tools/search-entities.js";
import { registerGetProblem } from "../tools/get-problem.js";
import { registerGetTrace } from "../tools/get-trace.js";
import { registerQueryUsql } from "../tools/query-usql.js";
import { registerGetSlo } from "../tools/get-slo.js";
import { registerQueryEvents } from "../tools/query-events.js";
import {
  registerGetExtension,
  registerListExtensionMonitoringConfigs,
  registerGetExtensionMonitoringConfig,
  registerGetExtensionMonitoringConfigStatus,
  registerGetExtensionEnvironmentConfig,
} from "../tools/extension-actions.js";
import { registerListChecks, registerRunChecks } from "../tools/run-checks.js";
import { registerTagSnapshot } from "../tools/tag-snapshot.js";
import { registerExtractTagSignals } from "../tools/extract-tag-signals.js";
import { registerSimulateTagStrategy } from "../tools/simulate-tag-strategy.js";
import { registerAuditPgNaming } from "../tools/audit-pg-naming.js";
import { registerAuditHostNaming } from "../tools/audit-host-naming.js";
import { registerAuditHostGroups } from "../tools/audit-host-groups.js";
import { registerAuditServiceNaming } from "../tools/audit-service-naming.js";
import { registerExportHostgroupRemediation } from "../tools/export-hostgroup-remediation.js";

/** Observability reads: metrics, logs, traces, problems, RUM, billing, tokens. */
export function registerObservabilityReads(server: McpServer, client: DtClient): void {
  registerConsumption(server, client);
  registerCalculatedServiceMetrics(server, client);
  registerServiceRequestCardinality(server, client);
  registerAuditLog(server, client);
  registerDashboards(server, client);
  registerApiTokens(server, client);
  registerOauthClients(server, client);
  registerProblemHistory(server, client);
  registerRumAppInventory(server, client);
  registerRumAppFeatureMatrix(server, client);
  registerListMetrics(server, client);
  registerGetMetricMetadata(server, client);
  registerGetDashboardContext(server, client);
  registerSearchLogs(server, client);
  registerQueryMetrics(server, client);
  registerSearchEntities(server, client);
  registerGetProblem(server, client);
  registerGetTrace(server, client);
  registerQueryUsql(server, client);
  registerGetSlo(server, client);
  registerQueryEvents(server, client);

  // Extensions 2.0 reads
  registerGetExtension(server, client);
  registerListExtensionMonitoringConfigs(server, client);
  registerGetExtensionMonitoringConfig(server, client);
  registerGetExtensionMonitoringConfigStatus(server, client);
  registerGetExtensionEnvironmentConfig(server, client);

  // Engine integration — MCP-to-MCP bridge to dt-engine
  registerListChecks(server);
  registerRunChecks(server, client);

  // Tag-strategy analyzers (engine-backed, 3-round loop)
  registerTagSnapshot(server, client);
  registerExtractTagSignals(server, client);
  registerSimulateTagStrategy(server, client);

  // Naming-hygiene analyzers (engine-backed, runs BEFORE tag work so
  // name-based tag rules become reliable). Compute order is bottom-up:
  // run PG audit first; host audit consumes PG evidence under the hood;
  // host-group audit consumes both. The export tool is pure local text
  // generation (no DtClient needed) for the no-write-API host-group layer.
  registerAuditPgNaming(server, client);
  registerAuditHostNaming(server, client);
  registerAuditHostGroups(server, client);
  registerAuditServiceNaming(server, client);
  registerExportHostgroupRemediation(server);
}
