import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface AuditLogResp {
  totalCount?: number;
  nextPageKey?: string | null;
  auditLogs?: Array<{
    logId?: string;
    timestamp?: number;
    user?: string;
    userType?: string;
    userOrigin?: string;
    eventType?: string;
    category?: string;
    entityId?: string;
    environmentId?: string;
    success?: boolean;
    patch?: unknown;
    [k: string]: unknown;
  }>;
}

export function registerAuditLog(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_audit_log_entries",
    {
      description:
        "Recent audit log entries via /api/v2/auditlogs. Useful for spotting config churn, who-changed-what, and unusual activity. Returns the raw entries plus a summary (count by category / by user / by success).",
      inputSchema: {
        from: z.string().optional().describe("Window start, e.g. 'now-7d'. Default now-7d."),
        to: z.string().optional().describe("Window end. Default now."),
        filter: z
          .string()
          .optional()
          .describe(
            "Optional Dynatrace audit-log filter, e.g. \"category(\\\"CONFIG\\\")\" or \"user(\\\"alice@example.com\\\")\"."
          ),
        maxPages: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ from, to, filter, maxPages }) => {
      const all: NonNullable<AuditLogResp["auditLogs"]> = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      const cap = maxPages ?? 20;
      const window = { from: from ?? "now-7d", to: to ?? "now" };
      do {
        const resp = nextPageKey
          ? await client.get<AuditLogResp>("/api/v2/auditlogs", { query: { nextPageKey } })
          : await client.get<AuditLogResp>("/api/v2/auditlogs", {
              query: { from: window.from, to: window.to, filter, pageSize: 1000 },
            });
        if (resp.auditLogs) all.push(...resp.auditLogs);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < cap);

      const byCategory = new Map<string, number>();
      const byUser = new Map<string, number>();
      const byEventType = new Map<string, number>();
      let failures = 0;
      for (const e of all) {
        byCategory.set(e.category ?? "?", (byCategory.get(e.category ?? "?") ?? 0) + 1);
        byUser.set(e.user ?? "?", (byUser.get(e.user ?? "?") ?? 0) + 1);
        byEventType.set(e.eventType ?? "?", (byEventType.get(e.eventType ?? "?") ?? 0) + 1);
        if (e.success === false) failures++;
      }

      const summary = {
        window,
        totalEntries: all.length,
        truncated: Boolean(nextPageKey),
        byCategory: Object.fromEntries(byCategory),
        byUser: Object.fromEntries(byUser),
        byEventType: Object.fromEntries(byEventType),
        failureCount: failures,
      };
      return { content: [{ type: "text", text: JSON.stringify({ summary, entries: all }, null, 2) }] };
    }
  );
}
