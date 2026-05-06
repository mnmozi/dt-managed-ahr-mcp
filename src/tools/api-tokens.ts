import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface TokenItem {
  id?: string;
  name?: string;
  owner?: string;
  enabled?: boolean;
  personalAccessToken?: boolean;
  creationDate?: string;
  expirationDate?: string | null;
  lastUsedDate?: string | null;
  scopes?: string[];
  modifiedDate?: string;
  [k: string]: unknown;
}

interface TokenListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  apiTokens?: TokenItem[];
}

const STALE_DAYS = 90;
const HIGH_PRIV_SCOPES = [
  "WriteConfig",
  "settings.write",
  "tenantTokenManagement.create",
  "tenantTokenManagement.delete",
  "credentialVault.write",
  "TenantTokenRotationServiceAPI",
];

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export function registerApiTokens(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_api_tokens",
    {
      description:
        "Inventory all API tokens via /api/v2/apiTokens. Returns full list and a security-focused summary: tokens with no expiration, expired-but-still-listed, never-used, unused for 90+ days, high-privilege (write) tokens, scope distribution, owner distribution.",
      inputSchema: {
        includeTokens: z
          .boolean()
          .optional()
          .describe("If true, returns the full token list (metadata only — no token values exist on this endpoint). Default false."),
      },
    },
    async ({ includeTokens }) => {
      const all: TokenItem[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      do {
        const resp = nextPageKey
          ? await client.get<TokenListResp>("/api/v2/apiTokens", {
              query: { nextPageKey },
            })
          : await client.get<TokenListResp>("/api/v2/apiTokens", {
              query: { pageSize: 500, fields: "id,name,owner,enabled,personalAccessToken,creationDate,expirationDate,lastUsedDate,scopes,modifiedDate" },
            });
        if (resp.apiTokens) all.push(...resp.apiTokens);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < 50);

      const noExpiration: TokenItem[] = [];
      const expired: TokenItem[] = [];
      const neverUsed: TokenItem[] = [];
      const staleUsage: TokenItem[] = [];
      const highPriv: TokenItem[] = [];
      const disabled: TokenItem[] = [];
      const scopeCounts = new Map<string, number>();
      const ownerCounts = new Map<string, number>();

      for (const t of all) {
        if (!t.expirationDate) noExpiration.push(t);
        else if ((daysAgo(t.expirationDate) ?? 0) > 0) expired.push(t);
        if (!t.lastUsedDate) neverUsed.push(t);
        else if ((daysAgo(t.lastUsedDate) ?? 0) > STALE_DAYS) staleUsage.push(t);
        if ((t.scopes ?? []).some((s) => HIGH_PRIV_SCOPES.includes(s))) highPriv.push(t);
        if (t.enabled === false) disabled.push(t);
        for (const s of t.scopes ?? []) scopeCounts.set(s, (scopeCounts.get(s) ?? 0) + 1);
        ownerCounts.set(t.owner ?? "?", (ownerCounts.get(t.owner ?? "?") ?? 0) + 1);
      }

      const trim = (arr: TokenItem[]) =>
        arr.slice(0, 50).map((t) => ({
          id: t.id,
          name: t.name,
          owner: t.owner,
          enabled: t.enabled,
          expirationDate: t.expirationDate,
          lastUsedDate: t.lastUsedDate,
          ageDays: daysAgo(t.creationDate),
          unusedDays: daysAgo(t.lastUsedDate),
          scopes: t.scopes,
        }));

      const summary = {
        totalTokens: all.length,
        scopeDistribution: Object.fromEntries(scopeCounts),
        ownerDistribution: Object.fromEntries(ownerCounts),
        findings: {
          noExpirationCount: noExpiration.length,
          noExpirationSample: trim(noExpiration),
          expiredCount: expired.length,
          expiredSample: trim(expired),
          neverUsedCount: neverUsed.length,
          neverUsedSample: trim(neverUsed),
          staleUsageOver90dCount: staleUsage.length,
          staleUsageSample: trim(staleUsage),
          highPrivilegeCount: highPriv.length,
          highPrivilegeSample: trim(highPriv),
          disabledCount: disabled.length,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(includeTokens ? { summary, tokens: all } : { summary }, null, 2),
          },
        ],
      };
    }
  );
}
