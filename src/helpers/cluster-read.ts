/**
 * Cluster-scoped reads (Cluster Management API v1 under /api/v1.0/onpremise
 * and Cluster API v2 under /api/cluster/v2). Same contract as the schema
 * wrappers' companion endpoints: every endpoint reports ok /
 * unsupported-on-this-version / error, and the whole read carries a
 * surfaceStatus so a fully-dead list can't pass as "nothing configured".
 *
 * These surfaces hold credentials-adjacent config (SMTP, LDAP bind, proxy);
 * responses are redacted before they leave the tool.
 */
import { DtApiError, type DtClient } from "../dt-client.js";

export const CLUSTER_V1 = "/api/v1.0/onpremise";
export const CLUSTER_V2 = "/api/cluster/v2";

export interface ClusterEndpoint {
  label: string;
  /** Full cluster-scoped path, e.g. "/api/v1.0/onpremise/cluster". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** 404 means the surface is absent on this Managed version or the feature is off. */
  optional?: boolean;
}

export type EndpointResult =
  | { path: string; status: "ok"; data: unknown }
  | { path: string; status: "unsupported-on-this-version" }
  | { path: string; status: "error"; httpStatus: number; message: string };

export interface ClusterReadResult {
  available: boolean;
  reason?: string;
  hint?: string;
  surfaceStatus?: "ok" | "partial" | "SURFACE_MISSING";
  endpoints?: Record<string, EndpointResult>;
}

const SECRET_KEY = /password|secret|privatekey|clientsecret|bindpassword/i;

/** Replace non-empty secret-looking string values with a marker, recursively. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SECRET_KEY.test(k) && typeof v === "string" && v.length > 0 ? "<redacted>" : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

export function isClusterTokenMissing(err: unknown): boolean {
  return err instanceof Error && /cluster-scoped call|DT_CLUSTER_TOKEN/.test(err.message);
}

export const NO_CLUSTER_TOKEN: ClusterReadResult = {
  available: false,
  reason: "no cluster token configured",
  hint: "Set DT_CLUSTER_TOKEN or DT_CLUSTER_TOKEN_FILE to a Cluster Management API token to enable cluster-scoped reads. Environment-scoped tools are unaffected.",
};

export async function clusterRead(
  client: DtClient,
  endpoints: ClusterEndpoint[]
): Promise<ClusterReadResult> {
  const out: Record<string, EndpointResult> = {};
  let ok = 0;
  let failed = 0;
  for (const ep of endpoints) {
    try {
      const data = await client.get<unknown>(ep.path, { scope: "cluster", query: ep.query });
      out[ep.label] = { path: ep.path, status: "ok", data: redactSecrets(data) };
      ok++;
    } catch (err) {
      if (isClusterTokenMissing(err)) return NO_CLUSTER_TOKEN;
      if (!(err instanceof DtApiError)) throw err;
      if (err.status === 404 && ep.optional) {
        out[ep.label] = { path: ep.path, status: "unsupported-on-this-version" };
        continue;
      }
      out[ep.label] = {
        path: ep.path,
        status: "error",
        httpStatus: err.status,
        message: err.body.slice(0, 300),
      };
      failed++;
    }
  }
  return {
    available: true,
    surfaceStatus: ok === 0 ? "SURFACE_MISSING" : failed > 0 ? "partial" : "ok",
    endpoints: out,
  };
}
