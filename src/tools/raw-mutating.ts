import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { mutateAndAudit, refuse } from "../helpers/mutate-and-audit.js";
import { checkClusterDenyList, denyResponse } from "../helpers/cluster-deny-list.js";

/**
 * Raw mutating escape hatches — siblings of dt_raw_get for the half of the
 * Dynatrace surface that has no typed wrapper. Each one:
 *   - takes an arbitrary env-scoped `path`
 *   - takes a `body` (POST/PUT/PATCH) or omits it (DELETE)
 *   - requires `confirm: "yes"`
 *   - is audited via the shared mutateAndAudit helper
 *   - uses the WRITE token
 *   - refuses paths on the cluster-admin deny-list (no override)
 *
 * Prefer a typed tool when one exists.
 */

const baseInputSchema = {
  path: z
    .string()
    .min(1)
    .describe(
      "API path starting with '/'. Do NOT include /e/<env>/ — it's added automatically. Examples: '/api/v2/tags', '/api/config/v1/autoTags', '/api/v2/slo'."
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Optional query parameters as a flat object."),
  contentType: z
    .string()
    .optional()
    .describe(
      "Content-Type header. Default 'application/json'. Set to 'text/plain' (or similar) when posting raw text — body will be sent unchanged."
    ),
};

export function registerRawPost(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    "dt_raw_post",
    {
      description:
        "Escape hatch: POST any env-scoped Dynatrace API path. REQUIRES confirm='yes'. Uses DT_WRITE_TOKEN. Audited. Prefer typed tools when one exists.",
      inputSchema: {
        ...baseInputSchema,
        body: z
          .union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()])
          .describe("Object/array → JSON-encoded. String → sent as-is when contentType is also set."),
        confirm: z.literal("yes"),
      },
    },
    async ({ path, body, query, contentType, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const deny = checkClusterDenyList(path);
      if (deny.denied) return denyResponse("dt_raw_post", deny);
      return mutateAndAudit({
        tool: "dt_raw_post",
        method: "POST",
        action: () => client.post("dt_raw_post", path, body, { query, contentType }),
        audit,
        requestBody: body,
        successKey: "ok",
      });
    }
  );
}

export function registerRawPut(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    "dt_raw_put",
    {
      description:
        "Escape hatch: PUT any env-scoped Dynatrace API path. REQUIRES confirm='yes'. Uses DT_WRITE_TOKEN. Audited.",
      inputSchema: {
        ...baseInputSchema,
        body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]),
        confirm: z.literal("yes"),
      },
    },
    async ({ path, body, query, contentType, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const deny = checkClusterDenyList(path);
      if (deny.denied) return denyResponse("dt_raw_put", deny);
      return mutateAndAudit({
        tool: "dt_raw_put",
        method: "PUT",
        action: () => client.put("dt_raw_put", path, body, { query, contentType }),
        audit,
        requestBody: body,
        successKey: "ok",
      });
    }
  );
}

export function registerRawDelete(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    "dt_raw_delete",
    {
      description:
        "Escape hatch: DELETE any env-scoped Dynatrace API path. REQUIRES confirm='yes'. Uses DT_WRITE_TOKEN. Audited.",
      inputSchema: {
        path: baseInputSchema.path,
        query: baseInputSchema.query,
        confirm: z.literal("yes"),
      },
    },
    async ({ path, query, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const deny = checkClusterDenyList(path);
      if (deny.denied) return denyResponse("dt_raw_delete", deny);
      return mutateAndAudit({
        tool: "dt_raw_delete",
        method: "DELETE",
        action: () => client.delete("dt_raw_delete", path, { query }),
        audit,
        requestBody: null,
        successKey: "ok",
      });
    }
  );
}

export function registerRawPatch(server: McpServer, client: DtClient, audit: AuditLog): void {
  server.registerTool(
    "dt_raw_patch",
    {
      description:
        "Escape hatch: PATCH any env-scoped Dynatrace API path. REQUIRES confirm='yes'. Uses DT_WRITE_TOKEN. Audited.",
      inputSchema: {
        ...baseInputSchema,
        body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]),
        confirm: z.literal("yes"),
      },
    },
    async ({ path, body, query, contentType, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const deny = checkClusterDenyList(path);
      if (deny.denied) return denyResponse("dt_raw_patch", deny);
      return mutateAndAudit({
        tool: "dt_raw_patch",
        method: "PATCH",
        action: () => client.patch("dt_raw_patch", path, body, { query, contentType }),
        audit,
        requestBody: body,
        successKey: "ok",
      });
    }
  );
}
