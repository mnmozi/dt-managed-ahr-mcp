import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";
import { classifyOrphans, type OrphanEntity } from "../helpers/orphan-classify.js";

interface EntListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  entities?: OrphanEntity[];
}

async function fetchAll(
  client: DtClient,
  selector: string,
  fields: string,
  from: string,
  to: string
): Promise<OrphanEntity[]> {
  const all: OrphanEntity[] = [];
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

/**
 * dt_get_entity_orphans — cross-entity orphan / zombie checks.
 *
 * The classification itself is a pure function (helpers/orphan-classify.ts)
 * that scans BOTH relationship maps per entity; this file only fetches.
 * Window defaults to 24h per the AHR convention; `lastSeenTms` is requested
 * explicitly because the entities list omits it by default.
 */
export function registerEntityOrphans(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_entity_orphans",
    {
      description:
        "Cross-entity orphan + zombie checks: SERVICEs with no backing PG/PGI (broken detection), HOSTs with no monitored PG/PGI (silent host), PGs with all PGIs gone (zombie), hosts not seen for >N days. Returns counts and per-category samples. Uses a 1d window for live data per the AHR convention; relationships are matched by target entity type so Managed-version relationship-name differences don't matter.",
      inputSchema: {
        from: z.string().optional().describe("Window for liveness check. Default 'now-24h'."),
        to: z.string().optional().describe("Default 'now'."),
        inactiveHostThresholdDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Days since lastSeen above which a host is considered inactive. Default 7."),
        sampleSize: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("How many entities to list per finding category. Default 30."),
      },
    },
    async ({ from, to, inactiveHostThresholdDays, sampleSize }) => {
      const window = { from: from ?? "now-24h", to: to ?? "now" };
      const thresholdDays = inactiveHostThresholdDays ?? 7;
      const sample = sampleSize ?? 30;
      const rel = "+fromRelationships,+toRelationships";

      let services: OrphanEntity[];
      let hosts: OrphanEntity[];
      let pgs: OrphanEntity[];
      let pgis: OrphanEntity[];
      try {
        [services, hosts, pgs, pgis] = await Promise.all([
          fetchAll(client, "type(SERVICE)", rel, window.from, window.to),
          fetchAll(client, "type(HOST)", `${rel},+lastSeenTms`, window.from, window.to),
          fetchAll(client, "type(PROCESS_GROUP)", rel, window.from, window.to),
          fetchAll(client, "type(PROCESS_GROUP_INSTANCE)", rel, window.from, window.to),
        ]);
      } catch (err) {
        if (err instanceof DtApiError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    available: false,
                    error: { status: err.status, body: err.body.slice(0, 500) },
                    hint: err.status === 403 ? "token needs the entities.read scope" : undefined,
                  },
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

      const result = classifyOrphans({
        services,
        hosts,
        processGroups: pgs,
        processGroupInstances: pgis,
        nowMs: Date.now(),
        inactiveAfterMs: thresholdDays * 86_400_000,
      });

      const slim = (e: OrphanEntity) => ({
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
          orphanServicesCount: result.orphanServices.length,
          orphanServicesSample: result.orphanServices.slice(0, sample).map(slim),
          zombieProcessGroupsCount: result.zombieProcessGroups.length,
          zombieProcessGroupsSample: result.zombieProcessGroups.slice(0, sample).map(slim),
          hostsWithNoMonitoredPgCount: result.hostsWithNoMonitoredPg.length,
          hostsWithNoMonitoredPgSample: result.hostsWithNoMonitoredPg.slice(0, sample).map(slim),
          inactiveHostsCount: result.inactiveHosts.length,
          inactiveHostsThresholdDays: thresholdDays,
          inactiveHostsSample: result.inactiveHosts.slice(0, sample).map(slim),
        },
        notes: [
          "orphanServices = no PROCESS_GROUP / PROCESS_GROUP_INSTANCE in either relationship map — service detection is broken or the backing process is gone.",
          "zombieProcessGroups = no PGI references this PG and the PG references no PGI.",
          "hostsWithNoMonitoredPg = OneAgent reports the host but nothing is deep-monitored on it — check monitoring mode / process-monitoring rules.",
          `inactiveHosts = lastSeenTms older than ${thresholdDays}d; hosts entirely outside the window are not returned by the API and so cannot appear here — widen 'from' to catch them.`,
        ],
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
