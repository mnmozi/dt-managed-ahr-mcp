import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";

import { registerValidateSettings } from "../tools/validate-settings.js";
import { registerCreateSettings } from "../tools/create-settings.js";
import { registerUpdateSettings } from "../tools/update-settings.js";
import { registerDeleteSettings } from "../tools/delete-settings.js";
import { registerIngestMetric } from "../tools/ingest-metric.js";
import { registerIngestLogs } from "../tools/ingest-logs.js";
import { registerIngestBizevent } from "../tools/ingest-bizevent.js";
import { registerPostEvent } from "../tools/post-event.js";
import { registerCreateDashboard } from "../tools/create-dashboard.js";
import { registerUpdateDashboard } from "../tools/update-dashboard.js";
import { registerDeleteDashboard } from "../tools/delete-dashboard.js";
import {
  registerRawPost,
  registerRawPut,
  registerRawDelete,
  registerRawPatch,
} from "../tools/raw-mutating.js";
import { registerCloseProblem, registerCommentProblem } from "../tools/problem-actions.js";
import { registerCreateToken, registerDeleteToken } from "../tools/token-actions.js";
import { registerAddTag, registerRemoveTag } from "../tools/tag-actions.js";
import { registerCreateSlo, registerUpdateSlo, registerDeleteSlo } from "../tools/slo-actions.js";
import {
  registerCreateSyntheticMonitor,
  registerUpdateSyntheticMonitor,
  registerDeleteSyntheticMonitor,
} from "../tools/synthetic-actions.js";
import {
  registerCreateExtensionMonitoringConfig,
  registerUpdateExtensionMonitoringConfig,
  registerDeleteExtensionMonitoringConfig,
  registerUpdateExtensionEnvironmentConfig,
} from "../tools/extension-actions.js";
import { registerApplyPgNamingRule } from "../tools/apply-pg-naming-rule.js";
import { registerApplyHostClarifyingTag } from "../tools/apply-host-clarifying-tag.js";
import { registerApplyServiceClarifyingTag } from "../tools/apply-service-clarifying-tag.js";

/** All write tools. Wired only when DT_WRITE_TOKEN is set. */
export function registerWrites(server: McpServer, client: DtClient, audit: AuditLog): void {
  // Settings 2.0
  registerValidateSettings(server, client, audit);
  registerCreateSettings(server, client, audit);
  registerUpdateSettings(server, client, audit);
  registerDeleteSettings(server, client, audit);

  // Ingestion
  registerIngestMetric(server, client, audit);
  registerIngestLogs(server, client, audit);
  registerIngestBizevent(server, client, audit);
  registerPostEvent(server, client, audit);

  // Dashboards
  registerCreateDashboard(server, client, audit);
  registerUpdateDashboard(server, client, audit);
  registerDeleteDashboard(server, client, audit);

  // Raw escape hatches
  registerRawPost(server, client, audit);
  registerRawPut(server, client, audit);
  registerRawDelete(server, client, audit);
  registerRawPatch(server, client, audit);

  // Problems
  registerCloseProblem(server, client, audit);
  registerCommentProblem(server, client, audit);

  // Tokens
  registerCreateToken(server, client, audit);
  registerDeleteToken(server, client, audit);

  // Tags
  registerAddTag(server, client, audit);
  registerRemoveTag(server, client, audit);

  // Naming hygiene — applies operator-approved naming decisions as
  // clarifying tags (name:<value>). Lattice-validated against the engine's
  // most recent dt_audit_*_naming reports. One apply tool per layer; both
  // share the validate-and-write helper.
  registerApplyPgNamingRule(server, client, audit);
  registerApplyHostClarifyingTag(server, client, audit);
  registerApplyServiceClarifyingTag(server, client, audit);

  // SLOs
  registerCreateSlo(server, client, audit);
  registerUpdateSlo(server, client, audit);
  registerDeleteSlo(server, client, audit);

  // Synthetic monitors
  registerCreateSyntheticMonitor(server, client, audit);
  registerUpdateSyntheticMonitor(server, client, audit);
  registerDeleteSyntheticMonitor(server, client, audit);

  // Extensions 2.0 writes
  registerCreateExtensionMonitoringConfig(server, client, audit);
  registerUpdateExtensionMonitoringConfig(server, client, audit);
  registerDeleteExtensionMonitoringConfig(server, client, audit);
  registerUpdateExtensionEnvironmentConfig(server, client, audit);
}
