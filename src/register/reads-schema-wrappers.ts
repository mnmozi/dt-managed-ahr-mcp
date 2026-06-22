import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";
import { registerSchemaWrapper } from "../tools/schema-wrapper.js";

/**
 * Declarative schema-wrapper registrations.
 *
 * Each wrapper probes N candidate schemaIds and reports per-schema availability.
 * This pattern is what lets us tolerate Managed-version drift — a schemaId
 * present in 1.290 may have been renamed by 1.330.
 *
 * Add new wrappers by appending entries to WRAPPERS below. The shape is enforced
 * by the registerSchemaWrapper signature.
 */

interface WrapperDef {
  toolName: string;
  description: string;
  schemaIds: string[];
}

const WRAPPERS: WrapperDef[] = [
  {
    toolName: "dt_get_service_anomaly_detection",
    description:
      "Anomaly detection configuration for SERVICEs. Returns the global service-AD config and any per-service overrides. Use to flag services with disabled AD, services with hyper-sensitive thresholds (noise source), and services with no overrides where one would help.",
    schemaIds: ["builtin:anomaly-detection.services", "builtin:anomaly-detection.service"],
  },
  {
    toolName: "dt_get_anomaly_detection",
    description:
      "Full anomaly-detection config surface beyond services: metric events (custom alert rules), infrastructure (hosts, disks), applications (RUM), databases, and the global frequent-issue detection toggle.",
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
  },
  {
    toolName: "dt_get_process_monitoring_rules",
    description:
      "Process-monitoring scope: which processes get deep-monitored (drives DDU + host-unit cost). Includes detection flags, monitoring rules, exclusion rules, technology-specific scope.",
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
  },
  {
    toolName: "dt_get_log_ingestion_rules",
    description:
      "Log ingestion / processing / storage / metric-extraction / sensitive-data masking. Major DDU-logs cost driver.",
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
  },
  {
    toolName: "dt_get_ownership_teams",
    description:
      "Ownership teams (builtin:ownership.teams). Pair with the de-facto ownership tag to see whether teams referenced in tags exist as ownership records.",
    schemaIds: ["builtin:ownership.teams", "builtin:ownership.config"],
  },
  {
    toolName: "dt_get_alerting_profiles",
    description:
      "Alerting profiles (builtin:alerting.profile). Control which problem severities/categories route to which integrations and management zones.",
    schemaIds: ["builtin:alerting.profile"],
  },
  {
    toolName: "dt_get_problem_notifications",
    description:
      "Problem notification integrations (Slack/Teams/email/webhook). Tries Settings 2.0 + AppSec notification schemas.",
    schemaIds: [
      "builtin:problem.notifications",
      "builtin:appsec.notification-integration",
      "builtin:appsec.notification-alerting-profile",
    ],
  },
  {
    toolName: "dt_get_audit_log_settings",
    description:
      "Audit-log configuration (builtin:audit-log). Different from the audit-log entries endpoint.",
    schemaIds: ["builtin:audit-log"],
  },
  {
    toolName: "dt_get_cloud_integration",
    description:
      "Cloud-platform integrations (AWS / Azure / GCP / VMware / CloudFoundry / Kubernetes). Tries known builtin schemas.",
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
  },
  {
    toolName: "dt_get_appsec_config",
    description:
      "Application Security configuration: vulnerability analysis, runtime application protection, code-level vulnerabilities, environment coverage, AppSec alerting.",
    schemaIds: [
      "builtin:appsec.runtime-vulnerability-detection",
      "builtin:appsec.code-level-vulnerability-rule-settings",
      "builtin:appsec.notification-alerting-profile",
      "builtin:appsec.notification-integration",
      "builtin:appsec.attack-protection-settings",
    ],
  },
  {
    toolName: "dt_get_rum_config",
    description:
      "Real User Monitoring config — comprehensive sweep of RUM-related Settings 2.0 schemas. Tolerant; per-schema absence reported.",
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
      // Web — enablement / name / replay
      "builtin:rum.web.enablement",
      "builtin:rum.web.name",
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
  },
  {
    toolName: "dt_get_business_events",
    description: "Business Events config (HTTP incoming + OneAgent + OpenTelemetry sources).",
    schemaIds: [
      "builtin:bizevents.http.incoming",
      "builtin:bizevents.processing.pipelines",
      "builtin:bizevents.oneagent",
    ],
  },
  {
    toolName: "dt_get_custom_services_and_key_requests",
    description: "Custom service definitions + key-request subscriptions.",
    schemaIds: [
      "builtin:custom-service",
      "builtin:settings.subscriptions.service",
      "builtin:custom-services.java",
      "builtin:custom-services.dotnet",
      "builtin:custom-services.go",
      "builtin:custom-services.nodejs",
      "builtin:custom-services.php",
    ],
  },
  {
    toolName: "dt_get_opentelemetry_config",
    description: "OpenTelemetry / OTLP ingestion settings + span schemas.",
    schemaIds: [
      "builtin:settings.opentelemetry",
      "builtin:span-attribute",
      "builtin:span-events",
      "builtin:span-capturing",
    ],
  },
  {
    toolName: "dt_get_release_monitoring",
    description: "Release/deployment events + release-stage detection rules.",
    schemaIds: [
      "builtin:settings.release-monitoring",
      "builtin:release-monitoring",
      "builtin:span-event-attribute",
    ],
  },
  {
    toolName: "dt_get_log_monitoring_extras",
    description:
      "Log monitoring meta surfaces beyond ingestion rules: feature flags, agent-side feature config, log monitoring on Grail activation.",
    schemaIds: [
      "builtin:logmonitoring.log-agent-feature-flags",
      "builtin:logmonitoring.logs-on-grail-activate",
      "builtin:logmonitoring.feature-config",
    ],
  },
  {
    toolName: "dt_get_network_zones",
    description: "Network zones — control how OneAgent connects to ActiveGates.",
    schemaIds: ["builtin:network-zones"],
  },
  {
    toolName: "dt_get_naming_rules",
    description:
      "Settings 2.0 conditional-naming rules for processes / hosts / services. Probes several likely schema IDs across Managed versions.",
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
  },
  {
    toolName: "dt_get_auto_tags",
    description: "List all auto-tagging rules (builtin:tags.auto-tagging).",
    schemaIds: ["builtin:tags.auto-tagging"],
  },
  {
    toolName: "dt_get_management_zones",
    description: "List all management zones (builtin:management-zones).",
    schemaIds: ["builtin:management-zones"],
  },
  {
    toolName: "dt_get_pg_detection_rules",
    description:
      "Process-group detection: advanced detection rules + global detection flags.",
    schemaIds: [
      "builtin:process-group.advanced-detection-rule",
      "builtin:process-group.detection-flags",
    ],
  },
  {
    toolName: "dt_get_service_detection_rules",
    description:
      "All four v1 service-detection schemas (full-web-service, full-web-request, external-web-service, external-web-request).",
    schemaIds: [
      "builtin:service-detection.full-web-service",
      "builtin:service-detection.full-web-request",
      "builtin:service-detection.external-web-service",
      "builtin:service-detection.external-web-request",
    ],
  },
  {
    toolName: "dt_get_request_naming",
    description: "Request-naming rules and request attributes.",
    schemaIds: ["builtin:service.request-naming", "builtin:service.request-attributes"],
  },
  {
    toolName: "dt_get_oneagent_features_and_enrichment",
    description:
      "OneAgent feature flags + metadata/context enrichment + log-agent feature flags. Tolerant probe across DT versions.",
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
  },
  {
    toolName: "dt_get_v2_service_detection",
    description:
      "v2 service detection (k8s + OTel-targeted). Covers service-detection-rules, service-splitting-rules, endpoint-detection-rules, url-path-pattern-matching-rules, endpoint metrics, API detection.",
    schemaIds: [
      "builtin:service-detection-rules",
      "builtin:service-splitting-rules",
      "builtin:endpoint-detection-rules",
      "builtin:url-path-pattern-matching-rules",
      "builtin:unified-services-endpoint-metrics",
      "builtin:apis.detection-rules",
    ],
  },
  {
    toolName: "dt_get_failure_detection",
    description: "Failure detection rulesets + env rules + per-protocol params.",
    schemaIds: [
      "builtin:failure-detection-rulesets",
      "builtin:failure-detection.environment.rules",
      "builtin:failure-detection.environment.parameters",
      "builtin:failure-detection.service.general-parameters",
      "builtin:failure-detection.service.http-parameters",
    ],
  },
  {
    toolName: "dt_get_trace_sampling_and_ingest",
    description:
      "Trace sampling + ingest control: URL/RPC sampling, per-env trace ingest control, global ingest control, muted requests.",
    schemaIds: [
      "builtin:url-based-sampling",
      "builtin:rpc-based-sampling",
      "builtin:trace.ingest.control",
      "builtin:global.trace.ingest.control",
      "builtin:settings.mutedrequests",
    ],
  },
  {
    toolName: "dt_get_span_capturing",
    description:
      "Trace sampling / span capturing rules + span-attribute extraction. Direct DDU-traces cost driver.",
    schemaIds: [
      "builtin:span-capturing",
      "builtin:span-attribute",
      "builtin:span-events",
      "builtin:span-event-attribute",
      "builtin:span-context-propagation",
    ],
  },
];

export function registerSchemaWrappers(server: McpServer, client: DtClient): void {
  for (const w of WRAPPERS) {
    registerSchemaWrapper(server, client, w);
  }
}
