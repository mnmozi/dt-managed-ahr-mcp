import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import {
  analyzeTokenSecurityAudit,
  type TokenRaw,
} from "../engine/analyzers/token-security-audit.js";

/**
 * dt_get_api_tokens — security-focused audit of API tokens.
 *
 * Piping: fetches /api/v2/apiTokens (paginated). Engine classifies tokens
 * into security findings (no-expiration, expired, never-used, stale,
 * high-privilege, disabled).
 *
 * The engine analyzer requires `nowMillis` to be reproducible — we pass
 * Date.now() at call time.
 */

interface TokenListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  apiTokens?: TokenRaw[];
}

export function registerApiTokens(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_api_tokens",
    {
      description:
        "Inventory API tokens via /api/v2/apiTokens with a security-focused classification: no-expiration, expired-but-listed, never-used, unused for 90+ days, high-privilege (write/admin scopes), disabled. Plus scope and owner distributions. Use this to answer: 'which tokens have no expiration?', 'are there tokens unused for 90+ days?', 'who owns the most write-scoped tokens?', 'which tokens are past their expiration but still listed?', 'show me high-privilege tokens that haven't been used recently'. Args: includeTokens (full list), staleUsageThresholdDays, highPrivilegeScopes.",
      inputSchema: {
        includeTokens: z
          .boolean()
          .optional()
          .describe(
            "If true, returns the full token list (metadata only — token values never exist on this endpoint). Default false."
          ),
        staleUsageThresholdDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Override the 'stale usage' threshold. Default 90 days. Tokens last used more than this many days ago are flagged in staleUsage*."
          ),
        highPrivilegeScopes: z
          .array(z.string())
          .optional()
          .describe(
            "Override the list of scopes that mark a token as high-privilege. Defaults to: WriteConfig, settings.write, tenantTokenManagement.create, tenantTokenManagement.delete, credentialVault.write, TenantTokenRotationServiceAPI."
          ),
      },
    },
    async ({ includeTokens, staleUsageThresholdDays, highPrivilegeScopes }) => {
      // 1. Paginate /api/v2/apiTokens
      const all: TokenRaw[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      do {
        const resp = nextPageKey
          ? await client.get<TokenListResp>("/api/v2/apiTokens", {
              query: { nextPageKey },
            })
          : await client.get<TokenListResp>("/api/v2/apiTokens", {
              query: {
                pageSize: 500,
                fields:
                  "id,name,owner,enabled,personalAccessToken,creationDate,expirationDate,lastUsedDate,scopes,modifiedDate",
              },
            });
        if (resp.apiTokens) all.push(...resp.apiTokens);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < 50);

      // 2. Engine
      let summary;
      try {
        const engine = await getEngine();
        summary = await analyzeTokenSecurityAudit(engine, {
          apiTokens: all,
          nowMillis: Date.now(),
          staleUsageThresholdDays,
          highPrivilegeScopes,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  available: false,
                  reason: "engine unavailable — compute could not run",
                  error: msg,
                  hint: "Set DT_ENGINE_BIN to the path of dt-engine.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const body: Record<string, unknown> = { summary };
      if (includeTokens) body.tokens = all;
      return {
        content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      };
    }
  );
}
