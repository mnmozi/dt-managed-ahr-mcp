import type { EngineClient } from "../engine-client.js";

/** Typed wrapper for the engine's `token.security_audit` analyzer. */

export interface TokenSecurityAuditInput {
  apiTokens: TokenRaw[];
  /** Reference time in Unix epoch milliseconds. REQUIRED for purity. */
  nowMillis: number;
  /** Default 90. Tokens last used more than this many days ago are flagged stale. */
  staleUsageThresholdDays?: number;
  /** Defaults to the engine's built-in list of write/admin scopes. */
  highPrivilegeScopes?: string[];
}

export interface TokenRaw {
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
}

export interface TokenSecurityAudit {
  totalTokens: number;
  scopeDistribution: Record<string, number>;
  ownerDistribution: Record<string, number>;
  findings: {
    noExpirationCount: number;
    noExpirationSample: TokenRow[] | null;
    expiredCount: number;
    expiredSample: TokenRow[] | null;
    neverUsedCount: number;
    neverUsedSample: TokenRow[] | null;
    staleUsageCount: number;
    staleUsageSample: TokenRow[] | null;
    highPrivilegeCount: number;
    highPrivilegeSample: TokenRow[] | null;
    disabledCount: number;
  };
  appliedDefaults: {
    staleUsageThresholdDays: number;
    highPrivilegeScopes: string[];
    nowMillis: number;
  };
}

export interface TokenRow {
  id?: string;
  name?: string;
  owner?: string;
  enabled?: boolean;
  expirationDate?: string;
  lastUsedDate?: string;
  ageDays?: number;
  unusedDays?: number;
  scopes?: string[];
}

export async function analyzeTokenSecurityAudit(
  engine: EngineClient,
  input: TokenSecurityAuditInput
): Promise<TokenSecurityAudit> {
  return engine.analyze<TokenSecurityAudit>("token.security_audit", input);
}
