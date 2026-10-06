import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

/**
 * dt_get_dashboard_context — one read that gathers everything a dashboard
 * builder needs to know about THIS tenant before constructing payload:
 *
 *   - management zones available (id + name) — needed for dashboardFilter +
 *     tileFilter references
 *   - entity types known on the tenant — confirms what type strings are valid
 *     in entitySelectors (HOST, SERVICE, …)
 *   - metrics catalog SUMMARY — counts by prefix (builtin:host.*, custom:*,
 *     etc.). Returning every metric is too big for one MCP response. The
 *     caller follows up with dt_list_metrics(metricSelector='builtin:host.*')
 *     to drill into a specific family.
 *   - a sampled set of the first 200 metric ids so the LLM has concrete
 *     example keys to start from. We include built-ins by default; pass
 *     `includeCustomMetrics: true` to also sample `custom:*`.
 *
 * Every section degrades gracefully — if one call fails, the others still
 * return. The caller sees `available: false` per section instead of a
 * hard error.
 */
export function registerGetDashboardContext(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_dashboard_context",
    {
      description:
        "Pre-flight context bundle for dashboard creation. Returns: all management zones (id+name), entity types, a metrics catalog SUMMARY (counts by prefix) plus a sample of metric ids. Run this BEFORE constructing a dashboard payload — it guarantees you only reference MZs that exist, entity types that exist, and metric keys that are real on this tenant. Each section degrades independently if the underlying endpoint errors.",
      inputSchema: {
        metricsSampleSize: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe("How many metric ids to include in the sample (default 200, max 500). Set 0 to skip the sample entirely (still returns the prefix summary)."),
        includeCustomMetrics: z
          .boolean()
          .optional()
          .describe("If true, fetch custom:* metrics in addition to builtin:*. Default false to keep the response compact."),
      },
    },
    async ({ metricsSampleSize, includeCustomMetrics }) => {
      const out: Record<string, unknown> = {};

      // (Cluster URL / env id are reported by dt_whoami; not duplicated here.)

      // ---------- management zones ----------
      out.managementZones = await safeSection(async () => {
        const resp = await client.get<{ values?: Array<{ id: string; name: string; description?: string }> }>(
          "/api/config/v1/managementZones"
        );
        const values = resp.values ?? [];
        return {
          count: values.length,
          zones: values.map((v) => ({ id: v.id, name: v.name, description: v.description })),
        };
      });

      // ---------- entity types ----------
      out.entityTypes = await safeSection(async () => {
        const resp = await client.get<{ types?: Array<{ type: string; displayName?: string; entityLimitExceeded?: boolean }> }>(
          "/api/v2/entityTypes",
          { query: { pageSize: 500 } }
        );
        const types = resp.types ?? [];
        return {
          count: types.length,
          types: types.map((t) => ({ type: t.type, displayName: t.displayName })),
        };
      });

      // ---------- metrics: prefix counts + sample ids ----------
      const sampleSize = metricsSampleSize ?? 200;
      out.metrics = await safeSection(async () => {
        // We paginate ONCE with metricSelector=builtin:* (and optionally custom:*)
        // and just collect ids. We don't pull metadata — the caller can follow
        // up via dt_get_metric_metadata for any specific one.
        const collect = async (selector: string): Promise<string[]> => {
          const ids: string[] = [];
          let nextPageKey: string | undefined;
          let pages = 0;
          do {
            const query: Record<string, string | number | undefined> = nextPageKey
              ? { nextPageKey }
              : { metricSelector: selector, pageSize: 500, fields: "metricId" };
            const page = await client.get<{ metrics?: Array<{ metricId: string }>; nextPageKey?: string | null }>(
              "/api/v2/metrics",
              { query }
            );
            for (const m of page.metrics ?? []) ids.push(m.metricId);
            nextPageKey = page.nextPageKey ?? undefined;
            pages++;
            // Safety cap — Managed clusters can have 10K+ metrics; we don't
            // want this one tool call to take forever.
            if (pages >= 10) break;
          } while (nextPageKey);
          return ids;
        };

        const builtinIds = await collect("builtin:*");
        const customIds = includeCustomMetrics ? await collect("custom:*") : [];
        const allIds = [...builtinIds, ...customIds];

        // Bucket by prefix (first two segments — e.g. builtin:host.*, builtin:service.*)
        const counts = new Map<string, number>();
        for (const id of allIds) {
          const prefix = prefixOf(id);
          counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        }
        const prefixSummary = Array.from(counts.entries())
          .map(([prefix, count]) => ({ prefix, count }))
          .sort((a, b) => b.count - a.count);

        // Sample — deterministic, takes the first N alphabetically per prefix
        // so the LLM doesn't see 200 host.* metrics and nothing else.
        const sample: string[] = [];
        if (sampleSize > 0) {
          const perPrefix = Math.max(1, Math.floor(sampleSize / Math.max(1, prefixSummary.length)));
          const byPrefix = new Map<string, string[]>();
          for (const id of allIds) {
            const p = prefixOf(id);
            if (!byPrefix.has(p)) byPrefix.set(p, []);
            byPrefix.get(p)!.push(id);
          }
          for (const [, ids] of byPrefix) {
            ids.sort();
            for (let i = 0; i < Math.min(perPrefix, ids.length) && sample.length < sampleSize; i++) {
              const id = ids[i];
              if (id !== undefined) sample.push(id);
            }
          }
        }

        return {
          total: allIds.length,
          totalBuiltin: builtinIds.length,
          totalCustom: customIds.length,
          customIncluded: includeCustomMetrics === true,
          prefixSummary,
          sample,
          note:
            "Use dt_list_metrics(metricSelector='<prefix>.*') to drill into a family, or dt_get_metric_metadata(metricKey='<key>') for one metric's full metadata.",
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );
}

async function safeSection<T>(fn: () => Promise<T>): Promise<{ available: true; data: T } | { available: false; error: string; status?: number }> {
  try {
    const data = await fn();
    return { available: true, data };
  } catch (err) {
    if (err instanceof DtApiError) {
      return { available: false, error: err.body.slice(0, 300), status: err.status };
    }
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function prefixOf(metricId: string): string {
  // builtin:host.cpu.usage  →  builtin:host
  // custom:my.app.payments  →  custom:my
  // builtin:billing.foo.bar →  builtin:billing
  const colonIdx = metricId.indexOf(":");
  if (colonIdx === -1) return metricId;
  const ns = metricId.slice(0, colonIdx); // "builtin"
  const rest = metricId.slice(colonIdx + 1);
  const dotIdx = rest.indexOf(".");
  const head = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
  return `${ns}:${head}`;
}
