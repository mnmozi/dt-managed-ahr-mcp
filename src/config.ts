import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DtConfig {
  clusterUrl: string;
  envId: string;
  token: string;
  clusterToken: string | null;
  writeToken: string | null;
  tlsVerify: boolean;
  auditDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[dt-mcp config] ${message}`);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new ConfigError(`${name} is not set`);
  }
  return v.trim();
}

function readTokenFile(path: string, label: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`cannot read ${label} at ${path}: ${msg}`);
  }
  const token = raw.trim();
  if (!token) {
    throw new ConfigError(`${label} file ${path} is empty`);
  }
  if (token.includes("\n")) {
    throw new ConfigError(`${label} file ${path} contains multiple lines; expected single line`);
  }
  return token;
}

/**
 * Resolves a token from either a direct env var or a file path env var.
 * Exactly one of the two must be set when `required` is true.
 */
function resolveToken(
  directValue: string | undefined,
  fileValue: string | undefined,
  directName: string,
  fileName: string,
  required: boolean
): string | null {
  const direct = directValue?.trim();
  const file = fileValue?.trim();

  if (direct && file) {
    throw new ConfigError(
      `both ${directName} and ${fileName} are set; choose one`
    );
  }
  if (direct) return direct;
  if (file) return readTokenFile(file, fileName);
  if (required) {
    throw new ConfigError(`neither ${directName} nor ${fileName} is set`);
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DtConfig {
  const clusterUrlRaw = requireEnv("DT_CLUSTER_URL");
  const clusterUrl = clusterUrlRaw.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(clusterUrl)) {
    throw new ConfigError(`DT_CLUSTER_URL must start with http:// or https://, got: ${clusterUrlRaw}`);
  }

  const envId = requireEnv("DT_ENV_ID");
  if (!/^[a-z0-9-]+$/i.test(envId)) {
    throw new ConfigError(`DT_ENV_ID does not look like a Dynatrace environment id: ${envId}`);
  }

  const token = resolveToken(
    env.DT_TOKEN,
    env.DT_TOKEN_FILE,
    "DT_TOKEN",
    "DT_TOKEN_FILE",
    true
  )!;

  const clusterToken = resolveToken(
    env.DT_CLUSTER_TOKEN,
    env.DT_CLUSTER_TOKEN_FILE,
    "DT_CLUSTER_TOKEN",
    "DT_CLUSTER_TOKEN_FILE",
    false
  );

  // Optional — when present, enables the write tools (settings create/update,
  // metric ingest, dashboard create/update). When absent, those tools refuse
  // at call time with a clear error and the MCP behaves as read-only.
  const writeToken = resolveToken(
    env.DT_WRITE_TOKEN,
    env.DT_WRITE_TOKEN_FILE,
    "DT_WRITE_TOKEN",
    "DT_WRITE_TOKEN_FILE",
    false
  );

  const tlsVerify = env.DT_TLS_VERIFY !== "0";
  const auditDir = env.DT_AUDIT_DIR?.trim() || join(process.cwd(), ".audit");

  return { clusterUrl, envId, token, clusterToken, writeToken, tlsVerify, auditDir };
}
