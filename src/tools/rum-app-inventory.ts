import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface EntityListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  entities?: Array<{
    entityId?: string;
    displayName?: string;
    type?: string;
    properties?: Record<string, unknown>;
    tags?: Array<{ context?: string; key?: string; value?: string }>;
    managementZones?: Array<{ id?: string; name?: string }>;
    [k: string]: unknown;
  }>;
}

interface MetricResp {
  result?: Array<{
    data?: Array<{
      dimensions?: string[];
      values?: number[];
    }>;
  }>;
}

const APP_TYPES = ["APPLICATION", "MOBILE_APPLICATION", "CUSTOM_APPLICATION"];

const SESSION_COUNT_METRICS: Record<string, string> = {
  APPLICATION: "builtin:apps.web.userSessions.count",
  MOBILE_APPLICATION: "builtin:apps.mobile.sessions.count",
  CUSTOM_APPLICATION: "builtin:apps.other.sessions.count",
};

async function fetchAll(
  client: DtClient,
  selector: string,
  fields: string,
  from: string,
  to: string
): Promise<NonNullable<EntityListResp["entities"]>> {
  const all: NonNullable<EntityListResp["entities"]> = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const resp = nextPageKey
      ? await client.get<EntityListResp>("/api/v2/entities", { query: { nextPageKey } })
      : await client.get<EntityListResp>("/api/v2/entities", {
          query: { entitySelector: selector, fields, from, to, pageSize: 500 },
        });
    if (resp.entities) all.push(...resp.entities);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < 50);
  return all;
}

async function sessionCount(
  client: DtClient,
  type: string,
  appId: string,
  from: string,
  to: string
): Promise<number | null> {
  const metric = SESSION_COUNT_METRICS[type];
  if (!metric) return null;
  try {
    const resp = await client.get<MetricResp>("/api/v2/metrics/query", {
      query: {
        metricSelector: metric,
        entitySelector: `entityId(${appId})`,
        from,
        to,
        resolution: "Inf",
      },
    });
    const v = resp.result?.[0]?.data?.[0]?.values?.[0];
    return typeof v === "number" && !Number.isNaN(v) ? v : 0;
  } catch (err) {
    if (err instanceof DtApiError) return null;
    throw err;
  }
}

export function registerRumAppInventory(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_rum_app_inventory",
    {
      description:
        "Discover RUM applications (APPLICATION, MOBILE_APPLICATION, CUSTOM_APPLICATION) with per-app session count, technology, tags, MZ membership. Window default 24h. Used as the inventory step before dt_get_rum_app_feature_matrix.",
      inputSchema: {
        from: z.string().optional().describe("Window start. Default 'now-24h'."),
        to: z.string().optional().describe("Window end. Default 'now'."),
        includeSessionCounts: z
          .boolean()
          .optional()
          .describe("If true, calls metrics API for each app (slower). Default true."),
      },
    },
    async ({ from, to, includeSessionCounts }) => {
      const window = { from: from ?? "now-24h", to: to ?? "now" };
      const wantCounts = includeSessionCounts ?? true;

      const out: Record<string, unknown> = { window, byType: {} };
      const byType = out.byType as Record<string, unknown>;
      let grandTotal = 0;
      let deadCount = 0;

      for (const t of APP_TYPES) {
        const apps = await fetchAll(
          client,
          `type(${t})`,
          "+properties,+managementZones,+tags",
          window.from,
          window.to
        );
        const enriched: unknown[] = [];
        for (const a of apps) {
          const id = a.entityId;
          if (!id) continue;
          const count = wantCounts ? await sessionCount(client, t, id, window.from, window.to) : null;
          if (count === 0) deadCount++;
          enriched.push({
            entityId: id,
            displayName: a.displayName,
            type: a.type,
            sessionCount: count,
            tags: a.tags,
            managementZones: a.managementZones,
            properties: a.properties,
          });
          grandTotal++;
        }
        byType[t] = { count: apps.length, apps: enriched };
      }
      out.totalApps = grandTotal;
      out.deadAppsCount = deadCount;
      out.notes = [
        "deadApps = sessionCount === 0 in the window — candidates for removal or coverage gap.",
        "Pass each appId to dt_get_rum_app_feature_matrix to audit per-app feature coverage.",
      ];

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );
}
