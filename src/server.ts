#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { DtClient } from "./dt-client.js";
import { registerListSchemas } from "./tools/list-schemas.js";
import { registerGetSchema } from "./tools/get-schema.js";
import { registerListSettingsObjects } from "./tools/list-settings-objects.js";
import { registerGetSettingsObject } from "./tools/get-settings-object.js";
import { registerRawGet } from "./tools/raw-get.js";
import { registerSchemaWrapper } from "./tools/schema-wrapper.js";
import { registerListTagsForEntity } from "./tools/entity-tags.js";
import { registerGetProcessProperties } from "./tools/get-process-properties.js";
import { registerConditionalNaming } from "./tools/conditional-naming.js";
import { registerWhoami } from "./tools/whoami.js";
import { registerOneAgentVersions } from "./tools/oneagent-versions.js";
import { registerOneAgentModuleStatus } from "./tools/oneagent-modules.js";
import { registerActiveGateVersions } from "./tools/activegate-versions.js";
import { registerMaintenanceWindows } from "./tools/maintenance-windows.js";
import { registerConsumption } from "./tools/consumption.js";
import { registerCalculatedServiceMetrics } from "./tools/calculated-service-metrics.js";
import { registerServiceRequestCardinality } from "./tools/service-request-cardinality.js";
import { registerExtensions } from "./tools/extensions.js";
import { registerAuditLog } from "./tools/audit-log.js";
import { registerSyntheticMonitors } from "./tools/synthetic-monitors.js";
import { registerDashboards } from "./tools/dashboards.js";
import { registerApiTokens } from "./tools/api-tokens.js";
import { registerOauthClients } from "./tools/oauth-clients.js";
import { registerProblemHistory } from "./tools/problem-history.js";
import { registerOrphanScopes } from "./tools/orphan-scopes.js";
import { registerEntityOrphans } from "./tools/entity-orphans.js";
import { registerRecentlyChanged } from "./tools/recently-changed.js";
import { registerRumAppInventory } from "./tools/rum-app-inventory.js";
import { registerRumAppFeatureMatrix } from "./tools/rum-app-feature-matrix.js";
import { registerSpecResources } from "./resources/specs.js";
import { registerAhrPrompt } from "./prompts/ahr.js";

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
    { name: "dt-managed-ahr-mcp", version: "0.0.1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  registerListSchemas(server, client);
  registerGetSchema(server, client);
  registerListSettingsObjects(server, client);
  registerGetSettingsObject(server, client);
  registerRawGet(server, client);
  registerListTagsForEntity(server, client);
  registerGetProcessProperties(server, client);
  registerConditionalNaming(server, client);

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_service_anomaly_detection",
    description:
      "Anomaly detection configuration for SERVICEs. Returns the global service-AD config and any per-service overrides. Use to flag services with disabled AD, services with hyper-sensitive thresholds (noise source), and services with no overrides where one would help.",
    schemaIds: [
      "builtin:anomaly-detection.services",
      "builtin:anomaly-detection.service",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_anomaly_detection",
    description:
      "Full anomaly-detection config surface beyond services: metric events (custom alert rules), infrastructure (hosts, disks), applications (RUM), databases, and the global frequent-issue detection toggle. Use to flag noisy categories, dead rules, and missing coverage.",
    schemaIds: [
      "builtin:anomaly-detection.metric-events",
      "builtin:anomaly-detection.infrastructure-hosts",
      "builtin:anomaly-detection.infrastructure-disks",
      "builtin:anomaly-detection.infrastructure-disks.classic",
      "builtin:anomaly-detection.infrastructure-vmware",
      "builtin:anomaly-detection.infrastructure-network",
      "builtin:anomaly-detection.applications",
      "builtin:anomaly-detection.applications-mobile",
      "builtin:anomaly-detection.databaseservices",
      "builtin:anomaly-detection.frequent-issues",
      "builtin:anomaly-detection.kubernetes.cluster",
      "builtin:anomaly-detection.kubernetes.namespace",
      "builtin:anomaly-detection.kubernetes.workload",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_process_monitoring_rules",
    description:
      "Process-monitoring scope: which processes get deep-monitored (drives DDU + host-unit cost). Includes detection flags, monitoring rules, exclusion rules, technology-specific scope. Pair with Phase 5 cost findings — overbroad monitoring is a common DDU spike cause.",
    schemaIds: [
      "builtin:process-availability",
      "builtin:host.process-monitoring",
      "builtin:process-monitoring",
      "builtin:process-monitoring.rule",
      "builtin:process-monitoring.builtin-monitoring-rule",
      "builtin:process-monitoring.technology-monitoring",
      "builtin:process-monitoring.docker-process-config",
      "builtin:process-monitoring.exclude-process",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_log_ingestion_rules",
    description:
      "Log ingestion / processing / storage / metric-extraction / sensitive-data masking. Major DDU-logs cost driver. Audit for: overbroad ingest patterns, missing sensitive-data masking, unused metric-extraction rules, log sources with no retention rule.",
    schemaIds: [
      "builtin:logmonitoring.log-storage-settings",
      "builtin:logmonitoring.log-buckets-rules",
      "builtin:logmonitoring.processing-rule",
      "builtin:logmonitoring.log-dpp-rules",
      "builtin:logmonitoring.metric-extraction",
      "builtin:logmonitoring.schemaless-log-metric",
      "builtin:logmonitoring.sensitive-data-masking",
      "builtin:logmonitoring.timestamp-configuration",
      "builtin:logmonitoring.log-events",
      "builtin:logmonitoring.log-agent-feature-flags",
      "builtin:logmonitoring.logs-on-grail-activate",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_ownership_teams",
    description:
      "Ownership teams (builtin:ownership.teams) — central directory of teams owning entities. Pair with the de-facto ownership tag from Phases 1/2/4 to see whether teams referenced in tags actually exist as ownership records.",
    schemaIds: ["builtin:ownership.teams", "builtin:ownership.config"],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_alerting_profiles",
    description:
      "Alerting profiles (builtin:alerting.profile) — control which problem severities/categories route to which integrations and management zones. Audit: orphaned profiles, profiles tied to dead MZs, profiles too coarse, profiles missing.",
    schemaIds: ["builtin:alerting.profile"],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_problem_notifications",
    description:
      "Problem notification integrations (Slack/Teams/email/webhook). Tries Settings 2.0 + AppSec notification schemas. Pair with dt_get_alerting_profiles to find profiles with no integration attached, dead integrations, or missing escalation paths.",
    schemaIds: [
      "builtin:problem.notifications",
      "builtin:appsec.notification-integration",
      "builtin:appsec.notification-alerting-profile",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_audit_log_settings",
    description:
      "Audit-log configuration (builtin:audit-log). Reports whether audit logging is enabled and what categories are captured. Different from the audit-log entries endpoint.",
    schemaIds: ["builtin:audit-log"],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_cloud_integration",
    description:
      "Cloud-platform integrations (AWS / Azure / GCP / VMware / CloudFoundry / Kubernetes). Tries known builtin schemas; per-schema absence reported. Use to flag broken integrations, missing credentials, or unmonitored cloud accounts.",
    schemaIds: [
      "builtin:cloud.aws",
      "builtin:cloud.aws.connection-settings",
      "builtin:cloud.azure",
      "builtin:cloud.gcp",
      "builtin:cloud.kubernetes",
      "builtin:cloud.cloudfoundry",
      "builtin:cloud.vmware",
      "builtin:cloud-integration.aws",
      "builtin:cloud-integration.azure",
      "builtin:cloud-integration.gcp",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_appsec_config",
    description:
      "Application Security configuration: vulnerability analysis, runtime application protection, code-level vulnerabilities, environment coverage, AppSec alerting profile, AppSec notifications.",
    schemaIds: [
      "builtin:appsec.runtime-vulnerability-detection",
      "builtin:appsec.code-level-vulnerability-rule-settings",
      "builtin:appsec.notification-alerting-profile",
      "builtin:appsec.notification-integration",
      "builtin:appsec.attack-protection-settings",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_rum_config",
    description:
      "Real User Monitoring configuration — comprehensive sweep of RUM-related Settings 2.0 schemas. Covers app detection, injection (auto/manual/custom), beacon endpoints, user tagging, user-action naming, key user actions, session properties, conversion goals, custom errors, request errors, exclusions (XHR / IP / browser), resource cleanup + types, apdex/KPM (load/xhr/custom + mobile), session replay (web + mobile + privacy), enablement (web/mobile/custom), provider breakdown, framework settings, geo/IP. Tolerant — per-schema absence is reported, not fatal.",
    schemaIds: [
      // Web — detection & injection
      "builtin:rum.web.app-detection",
      "builtin:rum.web.automatic-injection",
      "builtin:rum.web.manual-insertion",
      "builtin:rum.web.custom-injection-rules",
      "builtin:rum.web.injection.cookie",
      "builtin:rum.web.beacon-domain-origins",
      "builtin:rum.web.beacon-endpoint",
      "builtin:rum.web.rum-javascript-file-name",
      "builtin:rum.web.rum-javascript-updates",
      "builtin:rum.web.custom-rum-javascript-version",
      "builtin:rum.web.custom-configuration-properties",
      // Web — naming & actions
      "builtin:rum.user-action-naming.web",
      "builtin:rum.web.user-action-naming",
      "builtin:rum.key-user-actions",
      "builtin:rum.session-properties",
      "builtin:rum.conversion-goals",
      "builtin:user-action-custom-metrics",
      "builtin:custom-metrics",
      // Web — errors & request shaping
      "builtin:rum.web.custom-errors",
      "builtin:rum.web.request-errors",
      // Web — exclusions
      "builtin:rum.web.xhr-exclusion",
      "builtin:rum.web.ipaddress-exclusion",
      "builtin:rum.web.browser-exclusion",
      // Web — resources
      "builtin:rum.web.resource-cleanup-rules",
      "builtin:rum.web.resource-types",
      "builtin:rum.resource-timing-origins",
      // Web — Apdex / KPM
      "builtin:rum.web.key-performance-metric-load-actions",
      "builtin:rum.web.key-performance-metric-xhr-actions",
      "builtin:rum.web.key-performance-metric-custom-actions",
      "builtin:rum.user-experience-score",
      // Web — enablement / cost
      "builtin:rum.web.enablement",
      // Web — naming
      "builtin:rum.web.name",
      // Web — session replay
      "builtin:rum.session-replay-web",
      "builtin:sessionreplay.web.privacy-preferences",
      "builtin:sessionreplay.web.resource-capturing",
      "builtin:sessionreplay.cookie",
      // Mobile
      "builtin:rum.user-action-naming.mobile",
      "builtin:rum.mobile.detection",
      "builtin:rum.mobile.beacon-endpoint",
      "builtin:rum.mobile.privacy",
      "builtin:rum.mobile.request-errors",
      "builtin:rum.mobile.key-performance-metrics",
      "builtin:rum.mobile.enablement",
      "builtin:rum.mobile.name",
      "builtin:rum.session-replay-mobile",
      // Custom apps
      "builtin:rum.custom.enablement",
      "builtin:rum.custom.name",
      // Cross-cutting
      "builtin:rum.user-tagging",
      "builtin:rum.ip-determination",
      "builtin:rum.ip-mappings",
      "builtin:rum.host-headers",
      "builtin:rum.provider-breakdown",
      "builtin:rum.processgroup",
      "builtin:rum.framework-settings",
      "builtin:preferences.privacy",
      "builtin:preferences.ipaddressmasking",
      "builtin:geo-settings",
      "builtin:usability-analytics",
      // Application detection at process group level
      "builtin:rum.injection",
      // RUM AD
      "builtin:anomaly-detection.rum-web",
      "builtin:anomaly-detection.rum-mobile",
      "builtin:anomaly-detection.rum-custom",
      "builtin:anomaly-detection.rum-mobile-crash-rate-increase",
      "builtin:anomaly-detection.rum-custom-crash-rate-increase",
      // Synthetic ↔ application linkage
      "builtin:synthetic.browser.assigned-applications",
      "builtin:synthetic.http.assigned-applications",
      // Session export
      "builtin:elasticsearch.user-session-export-settings-v2",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_business_events",
    description:
      "Business Events configuration (HTTP incoming + OneAgent + OpenTelemetry sources, processing pipelines).",
    schemaIds: [
      "builtin:bizevents.http.incoming",
      "builtin:bizevents.processing.pipelines",
      "builtin:bizevents.oneagent",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_custom_services_and_key_requests",
    description:
      "Custom service definitions + key-request subscriptions. Custom services often live alongside detection rules; key requests denote which requests trigger SLO tracking.",
    schemaIds: [
      "builtin:custom-service",
      "builtin:settings.subscriptions.service",
      "builtin:custom-services.java",
      "builtin:custom-services.dotnet",
      "builtin:custom-services.go",
      "builtin:custom-services.nodejs",
      "builtin:custom-services.php",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_opentelemetry_config",
    description:
      "OpenTelemetry / OTLP ingestion settings. Useful when the account is mixing OneAgent + OTel.",
    schemaIds: [
      "builtin:settings.opentelemetry",
      "builtin:span-attribute",
      "builtin:span-events",
      "builtin:span-capturing",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_release_monitoring",
    description:
      "Release monitoring config — release events, deployment events, and any release-stage detection rules.",
    schemaIds: [
      "builtin:settings.release-monitoring",
      "builtin:release-monitoring",
      "builtin:span-event-attribute",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_log_monitoring_extras",
    description:
      "Log monitoring meta surfaces beyond ingestion rules: feature flag toggles, agent-side feature config, log monitoring on Grail activation. Pair with dt_get_log_ingestion_rules.",
    schemaIds: [
      "builtin:logmonitoring.log-agent-feature-flags",
      "builtin:logmonitoring.logs-on-grail-activate",
      "builtin:logmonitoring.feature-config",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_network_zones",
    description:
      "Network zones — control how OneAgent connects to ActiveGates. Misrouting causes reliability + cost issues. Audit: zones not matched to any AG, zones with no fallback, OneAgents pinned to a single zone with no failover.",
    schemaIds: [
      "builtin:network-zones",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_naming_rules",
    description:
      "Return Settings 2.0 conditional-naming rules for processes / hosts / services. Probes several likely schema IDs across Managed versions; per-schema errors (e.g. schema not present on this version) are reported instead of failing the tool.",
    schemaIds: [
      "builtin:conditional-naming.processgroup",
      "builtin:conditional-naming.process-group",
      "builtin:processgroup.naming",
      "builtin:process-group.naming",
      "builtin:conditional-naming.host",
      "builtin:host.naming",
      "builtin:conditional-naming.service",
      "builtin:service.naming",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_auto_tags",
    description:
      "List all auto-tagging rules (builtin:tags.auto-tagging). Each rule defines conditions that automatically apply a tag to matching entities. Use this to audit tag hygiene and rule overlap.",
    schemaIds: ["builtin:tags.auto-tagging"],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_management_zones",
    description:
      "List all management zones (builtin:management-zones). Each MZ is a named set of matching rules that scopes who sees which entities.",
    schemaIds: ["builtin:management-zones"],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_pg_detection_rules",
    description:
      "Return process-group detection configuration: both advanced detection rules and the global detection flags. Use this to audit why PGIs are (or aren't) being grouped the way they are.",
    schemaIds: [
      "builtin:process-group.advanced-detection-rule",
      "builtin:process-group.detection-flags",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_service_detection_rules",
    description:
      "Return all service-detection rules across the four built-in flavors (full-web-service, full-web-request, external-web-service, external-web-request).",
    schemaIds: [
      "builtin:service-detection.full-web-service",
      "builtin:service-detection.full-web-request",
      "builtin:service-detection.external-web-service",
      "builtin:service-detection.external-web-request",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_request_naming",
    description:
      "Return request-naming rules and request attributes — both affect how service calls are labeled and split.",
    schemaIds: [
      "builtin:service.request-naming",
      "builtin:service.request-attributes",
    ],
  });

  registerWhoami(server, cfg);
  registerOneAgentVersions(server, client);
  registerOneAgentModuleStatus(server, client);

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_oneagent_features_and_enrichment",
    description:
      "OneAgent feature flags + metadata/context enrichment + log-agent feature flags. Probes likely Settings 2.0 schemas across DT versions: per-schema absence is reported, not fatal. Use to confirm: metadata enrichment is on (env-var → tag flow works), log-agent feature flags aren't disabling log capture, and OneAgent runtime features match the AHR's expectations.",
    schemaIds: [
      "builtin:hostmonitoring.metadata-enrichment",
      "builtin:host.metadata-enrichment",
      "builtin:metadata-enrichment",
      "builtin:host.metadata",
      "builtin:logmonitoring.log-agent-feature-flags",
      "builtin:logmonitoring.feature-config",
      "builtin:oneagent.features",
      "builtin:oneagent.runtime",
      "builtin:eec-local",
      "builtin:eec-remote",
    ],
  });
  registerActiveGateVersions(server, client);
  registerMaintenanceWindows(server, client);
  registerConsumption(server, client);
  registerCalculatedServiceMetrics(server, client);
  registerServiceRequestCardinality(server, client);
  registerExtensions(server, client);
  registerAuditLog(server, client);
  registerSyntheticMonitors(server, client);
  registerDashboards(server, client);
  registerApiTokens(server, client);
  registerOauthClients(server, client);
  registerProblemHistory(server, client);
  registerOrphanScopes(server, client);
  registerEntityOrphans(server, client);
  registerRecentlyChanged(server, client);
  registerRumAppInventory(server, client);
  registerRumAppFeatureMatrix(server, client);

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_v2_service_detection",
    description:
      "v2 service detection surface (k8s + OTel-targeted). Covers: unified service detection rules, service splitting, endpoint detection, URL path pattern matching, endpoint metrics, API detection. These apply to k8s-discovered services and OTel-instrumented services that DON'T go through OneAgent's classic full-web-request pipeline. Use alongside dt_get_service_detection_rules (which is v1) — both v1 and v2 typically coexist on the same cluster.",
    schemaIds: [
      "builtin:service-detection-rules",
      "builtin:service-splitting-rules",
      "builtin:endpoint-detection-rules",
      "builtin:url-path-pattern-matching-rules",
      "builtin:unified-services-endpoint-metrics",
      "builtin:apis.detection-rules",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_failure_detection",
    description:
      "Failure detection rulesets, environment rules, environment parameters, and per-protocol failure parameters (general + HTTP). Audit: rules with overbroad conditions (everything-fails-loudly), dead rules (zero matches), missing custom rules for known-bad-but-not-default cases.",
    schemaIds: [
      "builtin:failure-detection-rulesets",
      "builtin:failure-detection.environment.rules",
      "builtin:failure-detection.environment.parameters",
      "builtin:failure-detection.service.general-parameters",
      "builtin:failure-detection.service.http-parameters",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_trace_sampling_and_ingest",
    description:
      "Trace sampling + ingest control: HTTP-based sampling, RPC-based sampling, per-env trace ingest control, global trace ingest control, muted requests. Direct DDU-traces cost driver — pair with Phase 5 cost findings. Flag: no sampling rules at all (everything captured = max cost), overbroad mute rules (silently dropping useful traces), conflicting rate caps.",
    schemaIds: [
      "builtin:url-based-sampling",
      "builtin:rpc-based-sampling",
      "builtin:trace.ingest.control",
      "builtin:global.trace.ingest.control",
      "builtin:settings.mutedrequests",
    ],
  });

  registerSchemaWrapper(server, client, {
    toolName: "dt_get_span_capturing",
    description:
      "Trace sampling / span capturing rules. Direct DDU-traces cost driver. Audit: overbroad capture rules, missing sampling, span-attribute extraction creating high-cardinality attributes.",
    schemaIds: [
      "builtin:span-capturing",
      "builtin:span-attribute",
      "builtin:span-events",
      "builtin:span-event-attribute",
      "builtin:span-context-propagation",
    ],
  });

  registerSpecResources(server, client, cfg);
  registerAhrPrompt(server);

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
  process.stderr.write(`[dt-mcp fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
