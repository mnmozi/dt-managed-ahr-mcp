import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";
import type { DtConfig } from "../config.js";

interface SpecDef {
  /** Stable slug used in the cache filename and MCP URI. */
  slug: string;
  /** Path on the Dynatrace API (env-scoped unless scope='cluster'). */
  apiPath: string;
  scope?: "env" | "cluster";
  /** Human-readable name shown to MCP clients. */
  displayName: string;
  description: string;
}

const SPECS: SpecDef[] = [
  {
    slug: "env-v2",
    apiPath: "/api/v2/spec3.json",
    scope: "env",
    displayName: "Environment API v2 (OpenAPI 3)",
    description:
      "OpenAPI 3 spec for the environment-scoped v2 REST API (entities, tags, settings, metrics, logs, events, problems).",
  },
  {
    slug: "env-config-v1",
    apiPath: "/api/config/v1/spec3.json",
    scope: "env",
    displayName: "Environment Config API v1 (OpenAPI 3)",
    description:
      "OpenAPI 3 spec for the environment-scoped v1 configuration API (anomaly detection, conditional naming, custom services, calculated metrics).",
  },
  {
    slug: "cluster-v1",
    apiPath: "/api/v1.0/onpremise/spec3.json",
    scope: "cluster",
    displayName: "Cluster API v1 (OpenAPI 3)",
    description:
      "OpenAPI 3 spec for the cluster-level v1 REST API (nodes, users, groups, cluster config). Requires a cluster token.",
  },
];

function cacheDirFor(clusterUrl: string): string {
  const host = new URL(clusterUrl).host.replace(/[^a-z0-9.-]/gi, "_");
  return join(process.cwd(), ".cache", "specs", host);
}

function cachePath(clusterUrl: string, slug: string): string {
  return join(cacheDirFor(clusterUrl), `${slug}.json`);
}

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24h

async function loadSpec(
  client: DtClient,
  cfg: DtConfig,
  spec: SpecDef
): Promise<{ body: string; fromCache: boolean }> {
  const path = cachePath(cfg.clusterUrl, spec.slug);
  if (existsSync(path)) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < MAX_CACHE_AGE_MS) {
      return { body: readFileSync(path, "utf8"), fromCache: true };
    }
  }
  const data = await client.get<unknown>(spec.apiPath, { scope: spec.scope ?? "env" });
  const body = typeof data === "string" ? data : JSON.stringify(data);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return { body, fromCache: false };
}

export function registerSpecResources(
  server: McpServer,
  client: DtClient,
  cfg: DtConfig
): void {
  for (const spec of SPECS) {
    const uri = `dt-spec://${spec.slug}`;
    server.registerResource(
      spec.slug,
      uri,
      {
        title: spec.displayName,
        description: spec.description,
        mimeType: "application/json",
      },
      async () => {
        // Cluster spec needs a cluster token — skip gracefully if not configured.
        if (spec.scope === "cluster" && !cfg.clusterToken) {
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(
                  {
                    error:
                      "cluster token not configured; set DT_CLUSTER_TOKEN or DT_CLUSTER_TOKEN_FILE to read cluster-scoped specs",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const { body } = await loadSpec(client, cfg, spec);
        return {
          contents: [{ uri, mimeType: "application/json", text: body }],
        };
      }
    );
  }
}
