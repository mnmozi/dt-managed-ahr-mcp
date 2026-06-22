import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { refuse } from "../helpers/mutate-and-audit.js";
import { safeDelete } from "../helpers/safe-delete.js";
import { textResult, type ToolResult } from "../helpers/tool-result.js";

/**
 * Token writes. dt_create_token is the only tool that doesn't use the generic
 * mutateAndAudit helper — it needs custom redaction logic to scrub the secret
 * before it hits the audit log on disk.
 */

const TOOL_CREATE = "dt_create_token";
const TOOL_DELETE = "dt_delete_token";

const REDACTED = "[REDACTED — actual value returned to caller only]";

export function registerCreateToken(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_CREATE,
    {
      description:
        "Create a new API token (POST /api/v2/apiTokens). The token value is returned ONCE in the response — save it immediately. **The audit log redacts the secret**; we never persist credential material to disk. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with apiTokens.write scope.",
      inputSchema: {
        name: z.string().min(1).describe("Human-readable token name. Surfaces in the audit log + UI."),
        scopes: z
          .array(z.string())
          .min(1)
          .describe(
            "Token scopes. Examples: ['entities.read'], ['settings.read','settings.write','metrics.ingest']. Grant only what the token needs."
          ),
        expirationDate: z
          .string()
          .optional()
          .describe(
            "ISO 8601 expiration timestamp, e.g. '2026-12-31T00:00:00Z'. Omit for non-expiring (NOT RECOMMENDED — non-expiring tokens are a common audit finding)."
          ),
        personalAccessToken: z
          .boolean()
          .optional()
          .describe("If true, bound to your user account. Default false (cluster-wide service token)."),
        confirm: z.literal("yes"),
      },
    },
    async ({ name, scopes, expirationDate, personalAccessToken, confirm }): Promise<ToolResult> => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const body: Record<string, unknown> = { name, scopes };
      if (expirationDate !== undefined) body.expirationDate = expirationDate;
      if (personalAccessToken !== undefined) body.personalAccessToken = personalAccessToken;
      try {
        const { status, path, data } = await client.post<{ id?: string; token?: string; [k: string]: unknown }>(
          TOOL_CREATE,
          "/api/v2/apiTokens",
          body
        );
        // REDACT before audit write — never let the secret hit disk.
        const redactedResponse: Record<string, unknown> = { ...(data as object) };
        if (typeof redactedResponse.token === "string") redactedResponse.token = REDACTED;
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL_CREATE,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: body,
          responseBody: redactedResponse,
        });
        return textResult({
          created: true,
          status,
          id: data.id,
          token: data.token, // returned ONCE to caller
          warning:
            "Save the 'token' field now — Dynatrace will not show it again. The audit log redacts it.",
          response: data,
        });
      } catch (err) {
        if (err instanceof WriteNotEnabledError) return textResult(err.message, true);
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL_CREATE,
            method: "POST",
            path: err.path,
            validateOnly: false,
            status: err.status,
            requestBody: body,
            error: err.body,
          });
          return textResult({ created: false, status: err.status, error: err.body }, true);
        }
        throw err;
      }
    }
  );
}

export function registerDeleteToken(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_DELETE,
    {
      description:
        "Delete an API token by id (DELETE /api/v2/apiTokens/{id}). Pre-fetches metadata + optional expectedName check. Metadata is logged; the secret value cannot be reconstructed. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with apiTokens.write scope.",
      inputSchema: {
        id: z.string().min(1).describe("Token id."),
        expectedName: z
          .string()
          .optional()
          .describe("If set, the token's name must equal this — otherwise the tool refuses."),
        force: z
          .boolean()
          .optional()
          .describe("Skip the pre-fetch + name check. Default false. Requires acknowledgeForce:true."),
        acknowledgeForce: z
          .boolean()
          .optional()
          .describe("Required companion to force:true; without it, force is rejected."),
        confirm: z.literal("yes"),
      },
    },
    async ({ id, expectedName, force, acknowledgeForce, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      const encoded = encodeURIComponent(id);
      return safeDelete({
        client,
        audit,
        tool: TOOL_DELETE,
        fetchPath: `/api/v2/apiTokens/${encoded}`,
        deletePath: `/api/v2/apiTokens/${encoded}`,
        objectId: id,
        force,
        acknowledgeForce,
        sanityCheck: (prior) => {
          if (!expectedName) return null;
          const priorName = (prior as { name?: string } | null)?.name;
          if (priorName && priorName !== expectedName) {
            return `name mismatch — token is named '${priorName}' but caller expected '${expectedName}'`;
          }
          return null;
        },
        priorBodyKey: "priorMetadata",
        notFoundLabel: "token",
        reversibleHint:
          "token value cannot be reconstructed — re-create via dt_create_token if needed",
        extraSuccess: (prior) => ({
          priorName: (prior as { name?: string } | null)?.name ?? null,
        }),
      });
    }
  );
}
