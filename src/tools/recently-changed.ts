import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  scope?: string;
  modified?: number;
  summary?: string;
  [k: string]: unknown;
}

interface SettingsListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

interface SchemaListResp {
  items?: Array<{ schemaId?: string }>;
}

/**
 * How many schemaIds to pack into one comma-separated settings/objects
 * request. ~227 schemas on 1.346 → ~12 requests at 20/batch.
 */
const BATCH_SIZE = 20;

export function registerRecentlyChanged(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_recently_changed_settings",
    {
      description:
        "List Settings 2.0 objects modified within the last N days, grouped by schema. Scans EVERY schema on the cluster by default (schema list fetched live, batched requests) so churn in schemas we didn't anticipate is never missed. Per-schema counts are exact; item lists are capped at maxItemsPerSchema (default 10, newest first) with an `omitted` count so a busy month can't overflow the result — re-query with schemaIds + a higher cap to drill in. Use to spot config churn (rules being repeatedly tweaked, recently disabled rules, automation churn). Pair with dt_get_audit_log_entries to attribute changes to users.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Look-back window in days. Default 30."),
        schemaIds: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict the scan to these schema ids. Default: every schema the cluster advertises via GET /api/v2/settings/schemas."
          ),
        maxItemsPerSchema: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Cap on listed objects per schema (newest first). Default 10. Counts stay exact; the rest is reported as `omitted`."
          ),
      },
    },
    async ({ days, schemaIds, maxItemsPerSchema }) => {
      const cutoffDays = days ?? 30;
      const cap = maxItemsPerSchema ?? 10;
      const cutoff = Date.now() - cutoffDays * 86400000;

      // Resolve the scan list: caller-supplied, or the live schema inventory.
      let schemas: string[];
      let schemaListError: string | undefined;
      if (schemaIds && schemaIds.length > 0) {
        schemas = schemaIds;
      } else {
        try {
          const resp = await client.get<SchemaListResp>("/api/v2/settings/schemas");
          schemas = (resp.items ?? [])
            .map((s) => s.schemaId)
            .filter((s): s is string => Boolean(s));
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: `could not list settings schemas: ${err instanceof Error ? err.message : String(err)}`,
                    hint: "Pass an explicit schemaIds[] to scan specific schemas, or check the settings.read token scope.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // Scan in comma-separated batches; every id comes from the live
      // inventory (or the caller), so batch-level 404s indicate a genuinely
      // bad id — reported per-batch, remaining batches still scanned.
      const changedBySchema = new Map<string, SettingsObject[]>();
      const batchErrors: Array<{ schemaIds: string[]; error: string }> = [];
      let scannedObjects = 0;

      for (let i = 0; i < schemas.length; i += BATCH_SIZE) {
        const batch = schemas.slice(i, i + BATCH_SIZE);
        try {
          let nextPageKey: string | null | undefined;
          let pages = 0;
          do {
            const resp = nextPageKey
              ? await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: { nextPageKey },
                })
              : await client.get<SettingsListResp>("/api/v2/settings/objects", {
                  query: {
                    schemaIds: batch.join(","),
                    pageSize: 500,
                    fields: "objectId,schemaId,scope,summary,modified",
                  },
                });
            for (const it of resp.items ?? []) {
              scannedObjects++;
              if ((it.modified ?? 0) >= cutoff) {
                const sid = it.schemaId ?? "(unknown)";
                const arr = changedBySchema.get(sid) ?? [];
                arr.push(it);
                changedBySchema.set(sid, arr);
              }
            }
            nextPageKey = resp.nextPageKey ?? null;
            pages++;
          } while (nextPageKey && pages < 50);
        } catch (err) {
          if (err instanceof DtApiError) {
            batchErrors.push({
              schemaIds: batch,
              error: `${err.status}: ${err.body.slice(0, 200)}`,
            });
          } else {
            throw err;
          }
        }
      }

      const perSchema = [...changedBySchema.entries()]
        .map(([schemaId, items]) => {
          const newestFirst = [...items].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
          return {
            schemaId,
            totalChanged: items.length,
            items: newestFirst.slice(0, cap),
            ...(items.length > cap ? { omitted: items.length - cap } : {}),
          };
        })
        .sort((a, b) => b.totalChanged - a.totalChanged);
      const grandTotal = perSchema.reduce((n, p) => n + p.totalChanged, 0);

      const summary = {
        windowDays: cutoffDays,
        cutoffEpochMs: cutoff,
        scannedSchemas: schemas.length,
        scannedObjects,
        maxItemsPerSchema: cap,
        schemasWithChanges: perSchema.length,
        totalChangedObjects: grandTotal,
        ...(schemaListError ? { schemaListError } : {}),
        ...(batchErrors.length > 0 ? { batchErrors } : {}),
        perSchema,
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
