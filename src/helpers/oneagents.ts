/**
 * OneAgent inventory with version tolerance. Managed 1.34x does not serve
 * /api/v2/oneagents (404) — the surface is /api/v1/oneagents, whose host
 * shape differs (hostInfo.displayName instead of hostName, agentVersion as
 * an object, softwareTechnologies instead of detectedTechnologies) and which
 * only includes module details with includeDetails=true. Every consumer
 * gets the v2 shape back, whichever endpoint answered.
 */
import { DtApiError, type DtClient } from "../dt-client.js";

export interface OneAgentModuleInstance {
  instanceName?: string;
  moduleVersion?: string;
  faultyVersion?: boolean;
  active?: boolean;
}

export interface OneAgentModule {
  moduleType?: string;
  enabled?: boolean;
  version?: string;
  misconfigured?: boolean;
  /** v1 only (Managed 1.350+): one entry per injected instance. */
  instances?: OneAgentModuleInstance[];
}

export interface OneAgentHost {
  hostInfo?: { hostName?: string; entityId?: string; osType?: string; [k: string]: unknown };
  monitoringType?: string;
  active?: boolean | null;
  faultyVersion?: boolean;
  modules?: OneAgentModule[];
  currentVersion?: string;
  installerVersion?: string;
  autoUpdateSetting?: string;
  updateStatus?: string;
  availabilityState?: string;
  detectedTechnologies?: Array<{ type?: string; version?: string }>;
  [k: string]: unknown;
}

export interface OneAgentInventory {
  hosts: OneAgentHost[];
  /** Which API answered — v1 hosts are normalized to the v2 shape. */
  source: "v2" | "v1";
}

interface ListResponse {
  nextPageKey?: string | null;
  hosts?: OneAgentHost[];
}

/** "1.346.0" from v1's {major, minor, revision} object; strings pass through. */
export function versionString(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const parts = [o.major, o.minor, o.revision].filter((p) => p !== undefined && p !== null);
    if (parts.length > 0) return parts.join(".");
  }
  return undefined;
}

/**
 * v1 modules (Managed 1.350+) carry instances[] with a per-instance `active`
 * flag and no `enabled`; read naively, every module looks disabled. Fold the
 * instances into enabled (any instance active) and version (first instance).
 * An explicit `enabled` always wins.
 */
export function normalizeModule(m: OneAgentModule): OneAgentModule {
  if (typeof m.enabled === "boolean" || !Array.isArray(m.instances)) return m;
  return {
    ...m,
    enabled: m.instances.some((i) => i.active === true),
    version: m.version ?? m.instances.find((i) => i.moduleVersion)?.moduleVersion,
  };
}

/** Map a /api/v1/oneagents host onto the v2 field names the analyzers use. */
export function normalizeV1Host(raw: OneAgentHost): OneAgentHost {
  const hi = (raw.hostInfo ?? {}) as Record<string, unknown>;
  const hostName =
    (hi.hostName as string | undefined) ??
    (hi.displayName as string | undefined) ??
    (hi.discoveredName as string | undefined) ??
    (hi.localHostName as string | undefined);
  const softwareTechs = Array.isArray(hi.softwareTechnologies)
    ? (hi.softwareTechnologies as Array<{ type?: string; version?: string }>).map((t) => ({
        type: t.type,
        version: t.version,
      }))
    : undefined;
  return {
    ...raw,
    hostInfo: { ...hi, hostName },
    monitoringType: raw.monitoringType ?? (hi.monitoringMode as string | undefined),
    currentVersion: raw.currentVersion ?? versionString(hi.agentVersion),
    detectedTechnologies: raw.detectedTechnologies ?? softwareTechs,
    modules: raw.modules?.map(normalizeModule),
  };
}

/**
 * Fetch every OneAgent host. Tries the paginated v2 endpoint first; a 404
 * there means this Managed version serves v1, which is fetched in one call
 * with includeDetails=true (modules are empty without it).
 */
export async function fetchOneAgents(
  client: DtClient,
  opts: { fields?: string; maxPages?: number } = {}
): Promise<OneAgentInventory> {
  const hosts: OneAgentHost[] = [];
  let nextPageKey: string | null | undefined;
  let pages = 0;
  const cap = opts.maxPages ?? 200;
  try {
    do {
      const resp = nextPageKey
        ? await client.get<ListResponse>("/api/v2/oneagents", { query: { nextPageKey } })
        : await client.get<ListResponse>("/api/v2/oneagents", {
            query: { pageSize: 500, fields: opts.fields },
          });
      if (resp.hosts) hosts.push(...resp.hosts);
      nextPageKey = resp.nextPageKey ?? null;
      pages++;
    } while (nextPageKey && pages < cap);
    return { hosts, source: "v2" };
  } catch (err) {
    if (!(err instanceof DtApiError) || err.status !== 404 || hosts.length > 0) throw err;
  }
  const v1 = await client.get<ListResponse>("/api/v1/oneagents", {
    query: { includeDetails: true },
  });
  return { hosts: (v1.hosts ?? []).map(normalizeV1Host), source: "v1" };
}
