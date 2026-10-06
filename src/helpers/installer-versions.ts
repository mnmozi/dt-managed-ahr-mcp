/**
 * "Latest available version" lookup for OneAgent / ActiveGate installers,
 * shared by dt_get_oneagent_versions and dt_get_activegate_versions.
 *
 * Two Managed-specific details that are easy to get wrong:
 *
 *  1. The OS identifier the inventories report (`/api/v2/oneagents`
 *     hostInfo.osType, `/api/v2/activeGates` osType — "LINUX", "WINDOWS",
 *     "AIX", …) is NOT the `{osType}` path segment the Deployment API
 *     expects. The Deployment API uses:
 *       OneAgent:   windows | unix | aix | solaris | zos
 *       ActiveGate: windows | unix
 *     "unix" covers every Linux flavour. Passing "linux" returns 404.
 *
 *  2. The endpoints differ per installer kind:
 *       OneAgent   GET /api/v1/deployment/installer/agent/{osType}/{installerType}/latest/metainfo
 *                  GET /api/v1/deployment/installer/agent/versions/{osType}/{installerType}
 *       ActiveGate GET /api/v1/deployment/installer/gateway/{osType}/latest/metainfo
 *                  GET /api/v1/deployment/installer/gateway/versions/{osType}
 *     (installerType is "default" for the self-extracting installer.)
 *     Both need the `InstallerDownload` token scope.
 *
 * On Managed 1.344+ the metainfo endpoint returns the environment's
 * configured auto-update *target* version when one is pinned, otherwise the
 * cluster-wide latest. Either way it is the right reference for
 * "how far behind is this host".
 */
import { DtApiError, type DtClient } from "../dt-client.js";

export type InstallerKind = "agent" | "gateway";

const AGENT_OS: Record<string, string> = {
  LINUX: "unix",
  UNIX: "unix",
  WINDOWS: "windows",
  AIX: "aix",
  SOLARIS: "solaris",
  ZOS: "zos",
};

const GATEWAY_OS: Record<string, string> = {
  LINUX: "unix",
  UNIX: "unix",
  WINDOWS: "windows",
};

export const SUPPORTED_INSTALLER_OS: Record<InstallerKind, string[]> = {
  agent: ["windows", "unix", "aix", "solaris", "zos"],
  gateway: ["windows", "unix"],
};

/**
 * Map an inventory osType ("LINUX", "WINDOWS_SERVER", "aix", …) to the
 * Deployment API path segment, or null when the Deployment API has no
 * installer for that OS (e.g. DARWIN, HPUX).
 */
export function toInstallerOsType(inventoryOsType: string, kind: InstallerKind): string | null {
  const key = inventoryOsType.trim().toUpperCase();
  if (!key) return null;
  const table = kind === "agent" ? AGENT_OS : GATEWAY_OS;
  const direct = table[key];
  if (direct) return direct;
  // Tolerate variants such as "WINDOWS_SERVER" / "LINUX_X86": match on the family token.
  const family = key.split(/[^A-Z]/)[0] ?? "";
  return table[family] ?? null;
}

/**
 * Numeric-aware pick of the highest version string. `availableVersions[]`
 * is not documented as sorted, so "last element" is not safe.
 * "1.301.2.20250101-120000" > "1.299.10.…" because segments compare as
 * numbers, not strings.
 */
export function pickLatestVersion(versions: readonly unknown[]): string | undefined {
  let best: string | undefined;
  let bestParts: number[] = [];
  for (const v of versions) {
    if (typeof v !== "string" || v.trim().length === 0) continue;
    const parts = v.split(/[^0-9]+/).filter((p) => p.length > 0).map(Number);
    if (parts.length === 0) continue;
    if (best === undefined || compareParts(parts, bestParts) > 0) {
      best = v;
      bestParts = parts;
    }
  }
  return best;
}

function compareParts(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface LatestVersionsResult {
  /** Keyed by the INVENTORY osType (uppercase), so the engine can join on it. */
  map: Record<string, string>;
  errors: Array<{ osType: string; error: string }>;
}

interface MetainfoResponse {
  latestAgentVersion?: string;
  latestGatewayVersion?: string;
}

interface VersionsResponse {
  availableVersions?: unknown[];
}

function describeError(err: unknown): string {
  if (err instanceof DtApiError) {
    return err.status === 403
      ? "HTTP 403 (token needs the InstallerDownload scope)"
      : `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the latest installer version for every inventory osType given.
 * Per-OS failures never fail the whole call; they are reported in `errors`
 * and the OS is simply absent from `map` (the engine then lists those
 * hosts/AGs under "...WithoutOsLatestReference").
 */
export async function fetchLatestInstallerVersions(
  client: DtClient,
  inventoryOsTypes: Iterable<string>,
  kind: InstallerKind
): Promise<LatestVersionsResult> {
  const map: Record<string, string> = {};
  const errors: Array<{ osType: string; error: string }> = [];
  // Several inventory values can map to one installer OS (LINUX, LINUX_X86 → unix);
  // resolve each installer OS once.
  const resolved = new Map<string, { version?: string; error?: string }>();

  for (const osType of inventoryOsTypes) {
    const key = osType.trim().toUpperCase();
    if (!key || key === "UNKNOWN") continue;
    const installerOs = toInstallerOsType(key, kind);
    if (!installerOs) {
      errors.push({
        osType: key,
        error: `no Deployment API installer for this OS (supported: ${SUPPORTED_INSTALLER_OS[kind].join(", ")})`,
      });
      continue;
    }
    let r = resolved.get(installerOs);
    if (!r) {
      r = await resolveOne(client, installerOs, kind);
      resolved.set(installerOs, r);
    }
    if (r.version) map[key] = r.version;
    else errors.push({ osType: key, error: r.error ?? "unknown error" });
  }
  return { map, errors };
}

async function resolveOne(
  client: DtClient,
  installerOs: string,
  kind: InstallerKind
): Promise<{ version?: string; error?: string }> {
  const seg = encodeURIComponent(installerOs);
  const metainfoPath =
    kind === "agent"
      ? `/api/v1/deployment/installer/agent/${seg}/default/latest/metainfo`
      : `/api/v1/deployment/installer/gateway/${seg}/latest/metainfo`;
  const versionsPath =
    kind === "agent"
      ? `/api/v1/deployment/installer/agent/versions/${seg}/default`
      : `/api/v1/deployment/installer/gateway/versions/${seg}`;

  let firstError: string | undefined;
  try {
    const resp = await client.get<MetainfoResponse>(metainfoPath);
    const v = resp?.latestGatewayVersion ?? resp?.latestAgentVersion;
    if (typeof v === "string" && v.length > 0) return { version: v };
    firstError = "metainfo response had no version field";
  } catch (err) {
    firstError = describeError(err);
  }
  try {
    const resp = await client.get<VersionsResponse>(versionsPath);
    const v = pickLatestVersion(resp?.availableVersions ?? []);
    if (v) return { version: v };
    return { error: `${firstError}; versions list empty` };
  } catch (err) {
    return { error: `${firstError}; versions fallback: ${describeError(err)}` };
  }
}
