import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { checkBlastRadius } from "../helpers/blast-radius.js";
import { refuse } from "../helpers/mutate-and-audit.js";

/**
 * Manual tag actions on entities. Distinct from auto-tag RULES (those live
 * in Settings 2.0 and are managed via dt_create_settings).
 *
 * SAFETY: every tag action pre-checks the entitySelector's match count
 * before mutating. Refuses on:
 *   - 0 matches (silent no-op is hostile)
 *   - > 10 matches without expectedMatchCount (caller must acknowledge size)
 *   - > 1000 matches without acknowledgeMassChange (extra explicit consent)
 *   - expectedMatchCount drift > 5% (cluster state changed since the caller
 *     last checked — re-confirm)
 *
 * Each tool's response includes matchedEntitiesCount so the caller sees
 * the impact even on success.
 */

const TOOL_ADD = "dt_add_tag";
const TOOL_REMOVE = "dt_remove_tag";

const blastRadiusArgs = {
  expectedMatchCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Required when the selector matches more than 10 entities. The pre-check will refuse with the actual count if missing. Engine then refuses if actual diverges from expected by more than 5% (e.g. cluster state changed)."
    ),
  acknowledgeMassChange: z
    .boolean()
    .optional()
    .describe(
      "Required when the selector matches more than 1000 entities. Strong guard against accidental mass mutations."
    ),
};

export function registerAddTag(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_ADD,
    {
      description:
        "Apply manual tags to entities matched by an entitySelector (POST /api/v2/tags). Adds CONTEXTLESS (manual) tags — for rule-based auto-tags use dt_create_settings against builtin:tags.auto-tagging. Pre-checks selector match count and refuses if too broad without explicit acknowledgment. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with entities.write scope. Audited.",
      inputSchema: {
        entitySelector: z
          .string()
          .min(1)
          .describe(
            "Selector matching the entities to tag. Examples: 'type(HOST),entityId(HOST-ABC)', 'type(SERVICE),tag(env:prod)'."
          ),
        tags: z
          .array(
            z.object({
              key: z.string().min(1).describe("Tag key. Lowercase + hyphenated is the de-facto convention."),
              value: z.string().optional().describe("Tag value. Omit for key-only tags."),
            })
          )
          .min(1)
          .describe("One or more tags to apply."),
        from: z
          .string()
          .optional()
          .describe("Time window start for the selector match (default 'now-24h')."),
        to: z.string().optional().describe("Time window end (default 'now')."),
        ...blastRadiusArgs,
        confirm: z.literal("yes"),
      },
    },
    async ({
      entitySelector,
      tags,
      from,
      to,
      expectedMatchCount,
      acknowledgeMassChange,
      confirm,
    }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");

      // Pre-check blast radius. Refuses on 0 matches, missing acknowledgment,
      // drift, or mass-change without consent.
      const check = await checkBlastRadius({
        client,
        tool: TOOL_ADD,
        entitySelector,
        expectedMatchCount,
        acknowledgeMassChange,
        from,
        to,
      });
      if (!check.ok) return check.refusal;

      const body = { tags };
      try {
        const { status, path, data } = await client.post<{
          matchedEntitiesCount?: number;
          appliedTags?: unknown[];
        }>(TOOL_ADD, "/api/v2/tags", body, {
          query: {
            entitySelector,
            from: from ?? "now-24h",
            to: to ?? "now",
          },
        });
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL_ADD,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: {
            entitySelector,
            body,
            preCheckMatchedCount: check.matchedCount,
          },
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  applied: true,
                  status,
                  matchedEntitiesCount: data.matchedEntitiesCount,
                  preCheckMatchedCount: check.matchedCount,
                  previewEntities: check.preview,
                  appliedTags: data.appliedTags,
                  entitySelector,
                  requested: tags,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL_ADD,
            method: "POST",
            path: err.path,
            validateOnly: false,
            status: err.status,
            requestBody: {
              entitySelector,
              body,
              preCheckMatchedCount: check.matchedCount,
            },
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { applied: false, status: err.status, error: err.body },
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
    }
  );
}

export function registerRemoveTag(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL_REMOVE,
    {
      description:
        "Remove a manual tag from entities matched by entitySelector (DELETE /api/v2/tags). Specify the exact key+value pair, OR pass deleteAllWithKey=true to remove every tag with that key regardless of value. Pre-checks selector match count and refuses if too broad without explicit acknowledgment. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN with entities.write. Only manual (CONTEXTLESS) tags can be removed this way — auto-tags are governed by their rules.",
      inputSchema: {
        entitySelector: z
          .string()
          .min(1)
          .describe("Entity selector. Same syntax as dt_add_tag / dt_search_entities."),
        key: z.string().min(1).describe("Tag key to remove."),
        value: z
          .string()
          .optional()
          .describe(
            "Tag value. Omit AND set deleteAllWithKey=true to remove every variant of the key."
          ),
        deleteAllWithKey: z
          .boolean()
          .optional()
          .describe("If true, remove all tags with the given key regardless of value. Default false."),
        from: z.string().optional().describe("Time window start (default 'now-24h')."),
        to: z.string().optional().describe("Time window end (default 'now')."),
        ...blastRadiusArgs,
        confirm: z.literal("yes"),
      },
    },
    async ({
      entitySelector,
      key,
      value,
      deleteAllWithKey,
      from,
      to,
      expectedMatchCount,
      acknowledgeMassChange,
      confirm,
    }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");
      if (!value && !deleteAllWithKey) {
        return refuse(
          "must specify either 'value' (remove specific value) or deleteAllWithKey:true (remove every variant of the key)"
        );
      }

      const check = await checkBlastRadius({
        client,
        tool: TOOL_REMOVE,
        entitySelector,
        expectedMatchCount,
        acknowledgeMassChange,
        from,
        to,
      });
      if (!check.ok) return check.refusal;

      try {
        const { status, path, data } = await client.delete<{
          matchedEntitiesCount?: number;
        }>(TOOL_REMOVE, "/api/v2/tags", {
          query: {
            entitySelector,
            key,
            value,
            deleteAllWithKey,
            from: from ?? "now-24h",
            to: to ?? "now",
          },
        });
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL_REMOVE,
          method: "DELETE",
          path,
          validateOnly: false,
          status,
          requestBody: {
            entitySelector,
            key,
            value,
            deleteAllWithKey,
            preCheckMatchedCount: check.matchedCount,
          },
          responseBody: data,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  removed: true,
                  status,
                  matchedEntitiesCount: data.matchedEntitiesCount,
                  preCheckMatchedCount: check.matchedCount,
                  previewEntities: check.preview,
                  entitySelector,
                  key,
                  value,
                  deleteAllWithKey: Boolean(deleteAllWithKey),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL_REMOVE,
            method: "DELETE",
            path: err.path,
            validateOnly: false,
            status: err.status,
            requestBody: {
              entitySelector,
              key,
              value,
              deleteAllWithKey,
              preCheckMatchedCount: check.matchedCount,
            },
            error: err.body,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { removed: false, status: err.status, error: err.body },
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
    }
  );
}
