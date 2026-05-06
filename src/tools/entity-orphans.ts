import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface EntitySlim {
  entityId?: string;
  displayName?: string;
  type?: string;
  fromRelationships?: Record<string, Array<{ id?: string; type?: string }>>;
  toRelationships?: Record<string, Array<{ id?: string; type?: string }>>;
  lastSeenTms?: number;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

interface EntListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  entities?: EntitySlim[];
}

async function fetchAll(
  client: DtClient,
  selector: string,
  fields: string,
  from: string,
  to: string
): Promise<EntitySlim[]> {
  const all: EntitySlim[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  do {
    const resp = nextPageKey
      ? await client.get<EntListResp>("/api/v2/entities", { query: { nextPageKey } })
      : await client.get<EntListResp>("/api/v2/entities", {
          query: { entitySelector: selector, fields, from, to, pageSize: 500 },
        });
    if (resp.entities) all.push(...resp.entities);
    nextPageKey = resp.nextPageKey ?? null;
    pages++;
  } while (nextPageKey && pages < 100);
  return all;
}

export function registerEntityOrphans(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_entity_orphans",
    {
      description:
        "Cross-entity orphan + zombie checks: SERVICEs with no backing PG, HOSTs with no monitored PG, PGs with all PGIs gone, hosts inactive >7 days. Returns counts and per-category samples. Uses 1d window for live data per the AHR convention.",
      inputSchema: {
        from: z.string().optional().describe("Window for liveness check. Default 'now-24h'."),
        to: z.string().optional().describe("Default 'now'."),
        inactiveHostThresholdDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Days since lastSeen above which a host is considered inactive. Default 7."),
      },
    },
    async ({ from, to, inactiveHostThresholdDays }) => {
      const window = { from: from ?? "now-24h", to: to ?? "now" };
      const inactiveAfter = (inactiveHostThresholdDays ?? 7) * 86400000;

      const services = await fetchAll(
        client,
        "type(SERVICE)",
        "+fromRelationships,+toRelationships",
        window.from,
        window.to
      );
      const hosts = await fetchAll(
        client,
        "type(HOST)",
        "+fromRelationships,+toRelationships,+properties.lastSeen,+lastSeenTms",
        window.from,
        window.to
      );
      const pgs = await fetchAll(
        client,
        "type(PROCESS_GROUP)",
        "+fromRelationships,+toRelationships",
        window.from,
        window.to
      );
      const pgis = await fetchAll(
        client,
        "type(PROCESS_GROUP_INSTANCE)",
        "+fromRelationships,+toRelationships",
        window.from,
        window.to
      );

      // SERVICE → PG via toRelationships.runsOn or runsOnProcessGroup
      const orphanServices = services.filter((s) => {
        const rel = s.toRelationships ?? s.fromRelationships ?? {};
        const linked = Object.values(rel)
          .flat()
          .some((e) => e.type === "PROCESS_GROUP" || e.type === "PROCESS_GROUP_INSTANCE");
        return !linked;
      });

      // PG with all PGIs gone — count PGIs whose toRelationships reference each PG
      const pgisByPg = new Map<string, number>();
      for (const pgi of pgis) {
        const rel = pgi.toRelationships ?? pgi.fromRelationships ?? {};
        for (const arr of Object.values(rel)) {
          for (const e of arr) {
            if (e.type === "PROCESS_GROUP" && e.id) {
              pgisByPg.set(e.id, (pgisByPg.get(e.id) ?? 0) + 1);
            }
          }
        }
      }
      const zombiePgs = pgs.filter((pg) => !pgisByPg.get(pg.entityId ?? ""));

      // HOST without monitored PG = host whose toRelationships has no PROCESS_GROUP
      const hostsNoPg = hosts.filter((h) => {
        const rel = h.toRelationships ?? h.fromRelationships ?? {};
        return !Object.values(rel)
          .flat()
          .some((e) => e.type === "PROCESS_GROUP" || e.type === "PROCESS_GROUP_INSTANCE");
      });

      // Inactive hosts (lastSeenTms older than threshold)
      const now = Date.now();
      const inactiveHosts = hosts.filter(
        (h) => h.lastSeenTms !== undefined && now - (h.lastSeenTms ?? 0) > inactiveAfter
      );

      const slim = (e: EntitySlim) => ({
        entityId: e.entityId,
        displayName: e.displayName,
        lastSeenTms: e.lastSeenTms,
      });

      const summary = {
        window,
        counts: {
          services: services.length,
          hosts: hosts.length,
          processGroups: pgs.length,
          processGroupInstances: pgis.length,
        },
        findings: {
          orphanServicesCount: orphanServices.length,
          orphanServicesSample: orphanServices.slice(0, 30).map(slim),
          zombieProcessGroupsCount: zombiePgs.length,
          zombieProcessGroupsSample: zombiePgs.slice(0, 30).map(slim),
          hostsWithNoMonitoredPgCount: hostsNoPg.length,
          hostsWithNoMonitoredPgSample: hostsNoPg.slice(0, 30).map(slim),
          inactiveHostsCount: inactiveHosts.length,
          inactiveHostsThresholdDays: inactiveHostThresholdDays ?? 7,
          inactiveHostsSample: inactiveHosts.slice(0, 30).map(slim),
        },
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
