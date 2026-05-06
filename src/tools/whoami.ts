import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Agent, request } from "undici";
import type { DtConfig } from "../config.js";

interface TokenLookupResponse {
  name?: string;
  owner?: string;
  scopes?: string[];
  enabled?: boolean;
  creationDate?: string;
  expirationDate?: string | null;
  lastUsedDate?: string | null;
  personalAccessToken?: boolean;
  [k: string]: unknown;
}

/**
 * Reports the MCP's effective configuration AND introspects the current token's
 * scopes. The token introspection requires POSTing the token in the request body —
 * we do this inline here rather than extend the (read-only) DtClient.
 */
export function registerWhoami(server: McpServer, cfg: DtConfig): void {
  server.registerTool(
    "dt_whoami",
    {
      description:
        "Report the MCP's effective configuration (cluster URL, env ID, TLS verify, cluster-token availability) AND introspect the current API token: name, owner, scopes, expiration, last-used. Run this in Phase 0 of any AHR — if a later tool returns 403, you'll know whether it's a missing scope.",
      inputSchema: {},
    },
    async () => {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.tlsVerify } });
      const base = `${cfg.clusterUrl}/e/${cfg.envId}`;
      const url = new URL(base + "/api/v2/apiTokens/lookup");

      let lookup: TokenLookupResponse | { error: string; status?: number } = {
        error: "not attempted",
      };
      try {
        const res = await request(url, {
          method: "POST",
          headers: {
            Authorization: `Api-Token ${cfg.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ token: cfg.token }),
          dispatcher,
        });
        const text = await res.body.text();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            lookup = JSON.parse(text) as TokenLookupResponse;
          } catch {
            lookup = { error: "non-JSON response", status: res.statusCode };
          }
        } else {
          lookup = { error: text.slice(0, 500), status: res.statusCode };
        }
      } catch (err) {
        lookup = { error: err instanceof Error ? err.message : String(err) };
      } finally {
        await dispatcher.close();
      }

      const result = {
        config: {
          clusterUrl: cfg.clusterUrl,
          envId: cfg.envId,
          tlsVerify: cfg.tlsVerify,
          clusterTokenConfigured: Boolean(cfg.clusterToken),
        },
        token: lookup,
        notes: [
          "If 'token' shows error 403 with 'apiTokens.read' or similar, the token can call other APIs but cannot introspect itself — that's expected for least-privilege AHR tokens.",
          "If 'token' shows scopes, cross-check them against tools you'll need: ReadConfig (Settings 2.0), entities.read (entities/tags), settings.read.",
        ],
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
