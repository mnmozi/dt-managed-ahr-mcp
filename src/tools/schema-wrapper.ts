import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, type DtClient } from "../dt-client.js";

interface SettingsObject {
  objectId?: string;
  schemaId?: string;
  scope?: string;
  summary?: string;
  value?: unknown;
  modified?: number;
  [k: string]: unknown;
}

interface SettingsListResponse {
  totalCount?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

/**
 * A non-Settings-2.0 endpoint fetched alongside the schema probes. On
 * Managed several surfaces (request naming, conditional naming, custom
 * services, releases) live in Config v1 or Environment v2, not Settings —
 * a wrapper that only probes Settings would return empty and lie.
 */
export interface CompanionEndpoint {
  /** Env-scoped API path, e.g. "/api/config/v1/service/requestNaming". */
  path: string;
  /** Short label used as the key in the output. */
  label: string;
  /**
   * When true, a 404 means "this sub-surface doesn't exist on this Managed
   * version" (e.g. customServices/dotnet on 1.346) — reported as
   * unsupported, NOT as an error and NOT as configured-empty.
   */
  notFoundMeansUnsupported?: boolean;
}

export interface SchemaWrapperOpts {
  toolName: string;
  description: string;
  schemaIds: string[];
  /** Config v1 / v2 endpoints that carry this surface on Managed. */
  companionEndpoints?: CompanionEndpoint[];
  /**
   * Included verbatim in every response. Use for known platform caveats,
   * e.g. "Business Events are SaaS/Grail-only — absence on Managed is
   * expected, not a config gap."
   */
  staticNote?: string;
}

/**
 * Advertised schema inventory (GET /api/v2/settings/schemas), cached per
 * process. The objects endpoint answers 200 for some schema ids the cluster
 * does NOT advertise (observed live: builtin:bizevents.http.incoming on
 * Managed 1.346 — a hidden/phantom schema). A probe only counts as alive
 * when the schema is advertised; otherwise it is reported as `phantom`.
 * If the inventory itself can't be fetched we fall back to trusting the
 * objects endpoint rather than failing the read.
 */
const INVENTORY_TTL_MS = 5 * 60 * 1000;
let inventoryCache: { ids: Set<string>; fetchedAt: number } | undefined;

async function advertisedSchemaIds(client: DtClient): Promise<Set<string> | undefined> {
  if (inventoryCache && Date.now() - inventoryCache.fetchedAt < INVENTORY_TTL_MS) {
    return inventoryCache.ids;
  }
  try {
    const resp = await client.get<{ items?: Array<{ schemaId?: string }> }>(
      "/api/v2/settings/schemas"
    );
    const ids = new Set(
      (resp.items ?? []).map((s) => s.schemaId).filter((s): s is string => Boolean(s))
    );
    inventoryCache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch {
    return undefined;
  }
}

/** Test hook: drop the cached inventory. */
export function resetSchemaInventoryCache(): void {
  inventoryCache = undefined;
}

/**
 * Fetch every object for a given schemaId across all pages. No `scopes`
 * filter is passed, so multi-scope schemas (e.g. disk-edge anomaly
 * detectors with HOST / HOST_GROUP / environment scopes) return objects
 * from ALL scopes — each item carries its own `scope` field.
 */
async function fetchAllForSchema(
  client: DtClient,
  schemaId: string,
  pageSize = 500,
  maxPages = 100
): Promise<{ items: SettingsObject[]; totalCount?: number; truncated: boolean }> {
  const all: SettingsObject[] = [];
  let nextPageKey: string | null | undefined;
  let totalCount: number | undefined;
  let pages = 0;

  do {
    const resp = nextPageKey
      ? await client.get<SettingsListResponse>("/api/v2/settings/objects", {
          query: { nextPageKey },
        })
      : await client.get<SettingsListResponse>("/api/v2/settings/objects", {
          query: {
            schemaIds: schemaId,
            pageSize,
            fields: "objectId,schemaId,scope,summary,value,modified",
          },
        });
    if (resp.items) all.push(...resp.items);
    nextPageKey = resp.nextPageKey ?? null;
    if (resp.totalCount !== undefined) totalCount = resp.totalCount;
    pages++;
  } while (nextPageKey && pages < maxPages);

  return { items: all, totalCount, truncated: Boolean(nextPageKey) };
}

/**
 * Registers a drift-tolerant read tool over one config surface: N candidate
 * Settings 2.0 schemaIds + optional Config v1 / v2 companion endpoints.
 *
 * The response always carries a top-level `surfaceStatus` so a fully-dead
 * probe list can never masquerade as "nothing configured":
 *
 *   "ok"              — at least one ADVERTISED schema probe succeeded
 *                       (a 200 from the objects endpoint for a schema the
 *                       cluster doesn't advertise is a phantom, not alive)
 *   "config-v1-only"  — every schema probe 404'd but a companion endpoint
 *                       answered (the surface lives outside Settings 2.0
 *                       on this Managed version)
 *   "SURFACE_MISSING" — every schema probe 404'd and no companion endpoint
 *                       answered. The surface has moved or been renamed —
 *                       the empty result is a TOOL blind spot, not evidence
 *                       that nothing is configured. Diff the probe list
 *                       against /api/v2/settings/schemas.
 */
export function registerSchemaWrapper(
  server: McpServer,
  client: DtClient,
  opts: SchemaWrapperOpts
): void {
  server.registerTool(
    opts.toolName,
    {
      description: opts.description,
      inputSchema: {
        scopeFilter: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive substring to filter on the 'scope' field (client-side)."
          ),
      },
    },
    async ({ scopeFilter }) => {
      const perSchema: Array<{
        schemaId: string;
        totalCount?: number;
        returned: number;
        truncated: boolean;
        items?: SettingsObject[];
        error?: { status: number; message: string };
        phantom?: boolean;
        note?: string;
      }> = [];
      let anySchemaAlive = false;
      const advertised = await advertisedSchemaIds(client);
      for (const schemaId of opts.schemaIds) {
        try {
          const { items, totalCount, truncated } = await fetchAllForSchema(client, schemaId);
          const phantom = advertised !== undefined && !advertised.has(schemaId);
          if (!phantom) anySchemaAlive = true;
          const filtered = scopeFilter
            ? items.filter((it) =>
                (it.scope ?? "").toLowerCase().includes(scopeFilter.toLowerCase())
              )
            : items;
          perSchema.push({
            schemaId,
            totalCount,
            returned: filtered.length,
            truncated,
            items: filtered,
            ...(phantom
              ? {
                  phantom: true,
                  note: "objects endpoint accepts this schema id but the cluster does not advertise the schema (hidden/phantom) — treated as absent",
                }
              : {}),
          });
        } catch (err) {
          if (err instanceof DtApiError) {
            perSchema.push({
              schemaId,
              returned: 0,
              truncated: false,
              error: { status: err.status, message: err.body.slice(0, 300) },
            });
          } else {
            throw err;
          }
        }
      }

      // Companion (non-Settings) endpoints — Config v1 / Environment v2.
      const companions: Record<
        string,
        | { path: string; status: "ok"; data: unknown }
        | { path: string; status: "unsupported-on-this-version" }
        | { path: string; status: "error"; httpStatus: number; message: string }
      > = {};
      let anyCompanionAlive = false;
      for (const ep of opts.companionEndpoints ?? []) {
        try {
          const data = await client.get<unknown>(ep.path);
          companions[ep.label] = { path: ep.path, status: "ok", data };
          anyCompanionAlive = true;
        } catch (err) {
          if (err instanceof DtApiError) {
            if (err.status === 404 && ep.notFoundMeansUnsupported) {
              companions[ep.label] = { path: ep.path, status: "unsupported-on-this-version" };
            } else {
              companions[ep.label] = {
                path: ep.path,
                status: "error",
                httpStatus: err.status,
                message: err.body.slice(0, 300),
              };
            }
          } else {
            throw err;
          }
        }
      }

      // A wrapper with a staticNote documents a surface KNOWN to be absent
      // on this platform (e.g. bizevents on Managed) — absence there is the
      // expected answer, not a tool blind spot.
      const surfaceStatus = anySchemaAlive
        ? "ok"
        : anyCompanionAlive
          ? "config-v1-only"
          : opts.staticNote
            ? "not-available-on-this-platform"
            : "SURFACE_MISSING";

      const out: Record<string, unknown> = { surfaceStatus, schemas: perSchema };
      if (opts.companionEndpoints?.length) out.companionEndpoints = companions;
      if (opts.staticNote) out.note = opts.staticNote;
      if (surfaceStatus === "SURFACE_MISSING") {
        out.warning =
          "EVERY schema probe 404'd and no companion endpoint answered. Do NOT read this as 'nothing configured' — the surface has likely been renamed on this Managed version. Run `npm run drift:schemas` (or diff the probe list against GET /api/v2/settings/schemas) and update the wrapper.";
      }
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        ...(surfaceStatus === "SURFACE_MISSING" ? { isError: true } : {}),
      };
    }
  );
}
