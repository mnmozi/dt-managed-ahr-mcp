import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { mutateAndAudit, refuse } from "../helpers/mutate-and-audit.js";
import { safeDelete } from "../helpers/safe-delete.js";

/**
 * Extensions 2.0 management. The existing `dt_get_extensions` lists installed
 * extensions. This set adds:
 *
 *   reads:
 *     - dt_get_extension                          one extension's metadata
 *     - dt_list_extension_monitoring_configs      monitoring configs for an extension
 *     - dt_get_extension_monitoring_config        single config
 *     - dt_get_extension_monitoring_config_status status (is the config actually collecting?)
 *     - dt_get_extension_environment_config       env-level toggle/config
 *
 *   writes:
 *     - dt_create_extension_monitoring_config
 *     - dt_update_extension_monitoring_config
 *     - dt_delete_extension_monitoring_config
 *     - dt_update_extension_environment_config
 *
 * Not included (deliberately):
 *   - dt_upload_extension (multipart/form-data ZIP upload — rare, use dt_raw_post)
 *   - dt_delete_extension (rare; use dt_raw_delete)
 */

// ---------- READS ----------

export function registerGetExtension(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_extension",
    {
      description:
        "Get extension metadata for one extension (GET /api/v2/extensions/{name}). Returns versions, author, dependencies. Pair with dt_get_extensions (the list).",
      inputSchema: {
        extensionName: z.string().min(1).describe("Extension fully-qualified name, e.g. 'com.dynatrace.extension.snmp-generic'."),
        version: z.string().optional().describe("Optional specific version. Default returns all versions."),
      },
    },
    async ({ extensionName, version }) => {
      const encodedName = encodeURIComponent(extensionName);
      const path = version
        ? `/api/v2/extensions/${encodedName}/${encodeURIComponent(version)}`
        : `/api/v2/extensions/${encodedName}`;
      try {
        const data = await client.get<unknown>(path);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export function registerListExtensionMonitoringConfigs(
  server: McpServer,
  client: DtClient
): void {
  server.registerTool(
    "dt_list_extension_monitoring_configs",
    {
      description:
        "List monitoring configurations for an extension (GET /api/v2/extensions/{name}/monitoringConfigurations). Each monitoring config is a specific deployment of the extension against a target (e.g. an SNMP device, a Kafka cluster).",
      inputSchema: {
        extensionName: z.string().min(1),
        version: z.string().optional().describe("Filter to one extension version."),
        active: z.boolean().optional().describe("If set, filter by active status."),
      },
    },
    async ({ extensionName, version, active }) => {
      const encodedName = encodeURIComponent(extensionName);
      try {
        const data = await client.get<unknown>(
          `/api/v2/extensions/${encodedName}/monitoringConfigurations`,
          { query: { version, active } }
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export function registerGetExtensionMonitoringConfig(
  server: McpServer,
  client: DtClient
): void {
  server.registerTool(
    "dt_get_extension_monitoring_config",
    {
      description:
        "Get one monitoring configuration (GET /api/v2/extensions/{name}/monitoringConfigurations/{id}). Returns the value (target, credentials refs, schedule) and metadata.",
      inputSchema: {
        extensionName: z.string().min(1),
        objectId: z.string().min(1).describe("Monitoring config objectId."),
      },
    },
    async ({ extensionName, objectId }) => {
      const encodedName = encodeURIComponent(extensionName);
      const encodedId = encodeURIComponent(objectId);
      try {
        const data = await client.get<unknown>(
          `/api/v2/extensions/${encodedName}/monitoringConfigurations/${encodedId}`
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export function registerGetExtensionMonitoringConfigStatus(
  server: McpServer,
  client: DtClient
): void {
  server.registerTool(
    "dt_get_extension_monitoring_config_status",
    {
      description:
        "Get the current operational status of a monitoring configuration (GET /api/v2/extensions/{name}/monitoringConfigurations/{id}/status). Tells you whether the config is actually collecting — distinct from whether it's enabled. Useful for 'why isn't this extension producing data?' debugging.",
      inputSchema: {
        extensionName: z.string().min(1),
        objectId: z.string().min(1),
      },
    },
    async ({ extensionName, objectId }) => {
      const encodedName = encodeURIComponent(extensionName);
      const encodedId = encodeURIComponent(objectId);
      try {
        const data = await client.get<unknown>(
          `/api/v2/extensions/${encodedName}/monitoringConfigurations/${encodedId}/status`
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export function registerGetExtensionEnvironmentConfig(
  server: McpServer,
  client: DtClient
): void {
  server.registerTool(
    "dt_get_extension_environment_config",
    {
      description:
        "Get the environment-level configuration for an extension (GET /api/v2/extensions/{name}/environmentConfiguration). This is the global config (which version is active, env-level enable/disable), distinct from per-target monitoring configs.",
      inputSchema: { extensionName: z.string().min(1) },
    },
    async ({ extensionName }) => {
      const encodedName = encodeURIComponent(extensionName);
      try {
        const data = await client.get<unknown>(
          `/api/v2/extensions/${encodedName}/environmentConfiguration`
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

// ---------- WRITES ----------

const monitoringConfigBody = z
  .object({
    enabled: z.boolean(),
    scope: z
      .string()
      .describe(
        "Where this config runs. Either an entity id (e.g. 'HOST_GROUP-...'), 'environment' for env-wide, or a management-zone scope."
      ),
    value: z
      .record(z.string(), z.unknown())
      .describe(
        "Extension-specific value. Shape depends on the extension's input schema — fetch via dt_get_schema(extensionName) first."
      ),
    version: z.string().optional().describe("Pin to a specific extension version. Default uses the activated one."),
  })
  .passthrough();

export function registerCreateExtensionMonitoringConfig(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  const TOOL = "dt_create_extension_monitoring_config";
  server.registerTool(
    TOOL,
    {
      description:
        "Create a monitoring configuration for an extension (POST /api/v2/extensions/{name}/monitoringConfigurations). Required: enabled, scope, value (extension-specific). REQUIRES confirm='yes'. Audited.",
      inputSchema: {
        extensionName: z.string().min(1),
        config: monitoringConfigBody,
        confirm: z.literal("yes"),
      },
    },
    async ({ extensionName, config, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encodedName = encodeURIComponent(extensionName);
      return mutateAndAudit({
        tool: TOOL,
        method: "POST",
        action: () =>
          client.post(TOOL, `/api/v2/extensions/${encodedName}/monitoringConfigurations`, config),
        audit,
        requestBody: { extensionName, config },
        successKey: "created",
      });
    }
  );
}

export function registerUpdateExtensionMonitoringConfig(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  const TOOL = "dt_update_extension_monitoring_config";
  server.registerTool(
    TOOL,
    {
      description:
        "Update a monitoring configuration (PUT /api/v2/extensions/{name}/monitoringConfigurations/{id}). FULL REPLACEMENT. REQUIRES confirm='yes'. Audited.",
      inputSchema: {
        extensionName: z.string().min(1),
        objectId: z.string().min(1),
        config: monitoringConfigBody,
        confirm: z.literal("yes"),
      },
    },
    async ({ extensionName, objectId, config, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encodedName = encodeURIComponent(extensionName);
      const encodedId = encodeURIComponent(objectId);
      return mutateAndAudit({
        tool: TOOL,
        method: "PUT",
        action: () =>
          client.put(
            TOOL,
            `/api/v2/extensions/${encodedName}/monitoringConfigurations/${encodedId}`,
            config
          ),
        audit,
        requestBody: { extensionName, objectId, config },
        objectId,
        successKey: "updated",
      });
    }
  );
}

export function registerDeleteExtensionMonitoringConfig(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  const TOOL = "dt_delete_extension_monitoring_config";
  server.registerTool(
    TOOL,
    {
      description:
        "Delete a monitoring configuration (DELETE /api/v2/extensions/{name}/monitoringConfigurations/{id}). Pre-fetches the config; prior body captured in audit log. REQUIRES confirm='yes'.",
      inputSchema: {
        extensionName: z.string().min(1),
        objectId: z.string().min(1),
        force: z
          .boolean()
          .optional()
          .describe("Skip pre-fetch + sanity check. Requires acknowledgeForce:true."),
        acknowledgeForce: z
          .boolean()
          .optional()
          .describe("Required companion to force:true; without it, force is rejected."),
        confirm: z.literal("yes"),
      },
    },
    async ({ extensionName, objectId, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encodedName = encodeURIComponent(extensionName);
      const encodedId = encodeURIComponent(objectId);
      const basePath = `/api/v2/extensions/${encodedName}/monitoringConfigurations/${encodedId}`;
      return safeDelete({
        client,
        audit,
        tool: TOOL,
        fetchPath: basePath,
        deletePath: basePath,
        objectId,
        force,
        acknowledgeForce,
        priorBodyKey: "priorConfig",
        notFoundLabel: "monitoring configuration",
        reversibleHint:
          "audit log entry contains priorConfig — re-create with dt_create_extension_monitoring_config",
      });
    }
  );
}

export function registerUpdateExtensionEnvironmentConfig(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  const TOOL = "dt_update_extension_environment_config";
  server.registerTool(
    TOOL,
    {
      description:
        "Update the environment-level config for an extension (PUT /api/v2/extensions/{name}/environmentConfiguration). Typically used to change the active version. REQUIRES confirm='yes'. Audited.",
      inputSchema: {
        extensionName: z.string().min(1),
        version: z.string().min(1).describe("Extension version to activate."),
        confirm: z.literal("yes"),
      },
    },
    async ({ extensionName, version, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encodedName = encodeURIComponent(extensionName);
      const body = { version };
      return mutateAndAudit({
        tool: TOOL,
        method: "PUT",
        action: () =>
          client.put(TOOL, `/api/v2/extensions/${encodedName}/environmentConfiguration`, body),
        audit,
        requestBody: { extensionName, body },
        successKey: "updated",
      });
    }
  );
}

// ---------- helpers ----------

function errorResult(err: unknown) {
  if (err instanceof DtApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { available: false, error: { status: err.status, body: err.body.slice(0, 500) } },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  throw err;
}
