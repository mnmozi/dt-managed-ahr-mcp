import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface Problem {
  problemId?: string;
  displayId?: string;
  title?: string;
  status?: string; // OPEN | CLOSED
  startTime?: number;
  endTime?: number;
  affectedEntities?: Array<{ entityId?: { id?: string; type?: string }; name?: string }>;
  rootCauseEntity?: { entityId?: { id?: string; type?: string }; name?: string };
  impactLevel?: string;
  severityLevel?: string;
  problemFilters?: Array<{ name?: string; id?: string }>;
  [k: string]: unknown;
}

interface ProblemListResp {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  problems?: Problem[];
}

function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

export function registerProblemHistory(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_problem_history",
    {
      description:
        "Pull problems over a window (default 30d) and compute Davis health metrics: MTTR (overall, p50, p95), top recurring root entities, top problem categories, currently-open problems older than N days (stuck/abandoned), and high-impact problem count.",
      inputSchema: {
        from: z.string().optional().describe("Window start, e.g. 'now-30d'. Default 'now-30d'."),
        to: z.string().optional().describe("Window end. Default 'now'."),
        oldOpenThresholdDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Open problems older than this many days are flagged. Default 7."),
        topN: z.number().int().min(1).max(50).optional().describe("Top-N entities + categories. Default 10."),
      },
    },
    async ({ from, to, oldOpenThresholdDays, topN }) => {
      const window = { from: from ?? "now-30d", to: to ?? "now" };
      const oldOpen = (oldOpenThresholdDays ?? 7) * 86400000;
      const top = topN ?? 10;

      const all: Problem[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      do {
        const resp = nextPageKey
          ? await client.get<ProblemListResp>("/api/v2/problems", { query: { nextPageKey } })
          : await client.get<ProblemListResp>("/api/v2/problems", {
              query: { from: window.from, to: window.to, pageSize: 500 },
            });
        if (resp.problems) all.push(...resp.problems);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < 50);

      const closed: Problem[] = [];
      const open: Problem[] = [];
      for (const p of all) {
        if (p.status === "CLOSED") closed.push(p);
        else open.push(p);
      }

      // MTTR — closed problems only
      const mttrSamples = closed
        .map((p) => (p.endTime && p.startTime ? p.endTime - p.startTime : null))
        .filter((v): v is number => v !== null && v > 0);
      const mttrMs = mttrSamples.reduce((a, b) => a + b, 0) / (mttrSamples.length || 1);
      const mttrSummary = {
        sampleSize: mttrSamples.length,
        meanMs: mttrSamples.length ? Math.round(mttrMs) : null,
        meanMinutes: mttrSamples.length ? Math.round(mttrMs / 60000) : null,
        p50Minutes: mttrSamples.length
          ? Math.round((percentile(mttrSamples, 50) ?? 0) / 60000)
          : null,
        p95Minutes: mttrSamples.length
          ? Math.round((percentile(mttrSamples, 95) ?? 0) / 60000)
          : null,
      };

      // Recurrence by root entity
      const byRoot = new Map<string, { count: number; name?: string; type?: string; titles: Set<string> }>();
      for (const p of all) {
        const id = p.rootCauseEntity?.entityId?.id;
        if (!id) continue;
        const e =
          byRoot.get(id) ??
          { count: 0, name: p.rootCauseEntity?.name, type: p.rootCauseEntity?.entityId?.type, titles: new Set<string>() };
        e.count++;
        if (p.title) e.titles.add(p.title);
        byRoot.set(id, e);
      }
      const topRecurring = [...byRoot.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, top)
        .map(([id, v]) => ({
          rootEntityId: id,
          rootEntityType: v.type,
          rootEntityName: v.name,
          problemCount: v.count,
          distinctTitles: [...v.titles],
        }));

      // Categories (use title prefix as a rough category)
      const byCategory = new Map<string, number>();
      for (const p of all) {
        const t = (p.title ?? "").split(" on ")[0]?.split(" of ")[0] ?? "?";
        byCategory.set(t, (byCategory.get(t) ?? 0) + 1);
      }
      const topCategories = [...byCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([category, count]) => ({ category, count }));

      // Stuck open
      const now = Date.now();
      const stuck = open.filter((p) => p.startTime && now - p.startTime > oldOpen);
      const stuckSample = stuck.slice(0, 30).map((p) => ({
        problemId: p.problemId,
        displayId: p.displayId,
        title: p.title,
        ageDays: p.startTime ? Math.round((now - p.startTime) / 86400000) : null,
      }));

      const summary = {
        window,
        totalProblems: all.length,
        openCount: open.length,
        closedCount: closed.length,
        mttr: mttrSummary,
        topRecurringRootEntities: topRecurring,
        topCategories,
        stuckOpenCount: stuck.length,
        stuckOpenThresholdDays: oldOpenThresholdDays ?? 7,
        stuckOpenSample: stuckSample,
      };

      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }
  );
}
