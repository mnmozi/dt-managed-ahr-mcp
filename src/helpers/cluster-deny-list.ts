/**
 * Deny-list of API path prefixes that the raw mutating tools (dt_raw_post /
 * put / patch / delete) must refuse outright.
 *
 * These are cluster-admin / tenant-config surfaces where an MCP-initiated
 * write is almost certainly a mistake — they reconfigure the whole Managed
 * cluster (license, users, cluster nodes, mTLS, SSO, …). We block them and
 * tell the caller to use the Cluster Management Console instead. There is
 * NO escape-hatch override on purpose — the raw tools are already an
 * escape hatch and an LLM caller has no good reason to reach into cluster
 * admin from a tenant-scoped MCP.
 *
 * Why deny here instead of relying on the token scope?
 *   - Tokens are issued once and re-used. A long-lived token can have more
 *     scope than any single tool needs.
 *   - We want the refusal to be diagnostic, not a 401 from upstream.
 */

import { textResult, type ToolResult } from "./tool-result.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("cluster-deny-list");

/**
 * Path prefixes that mean "you are talking to the cluster admin surface".
 * Matched case-insensitively against the normalized path (leading slash,
 * no env prefix — raw-* tools take env-scoped paths so cluster paths
 * shouldn't appear at all, but callers sometimes paste full URLs).
 *
 * Each prefix is paired with a hint for the caller.
 */
export const CLUSTER_DENY_PREFIXES: Array<{ prefix: string; hint: string }> = [
  {
    prefix: "/api/v1.0/onpremise/cluster",
    hint: "Cluster-level config. Use the Cluster Management Console (CMC) UI.",
  },
  {
    prefix: "/api/v1.0/onpremise/license",
    hint: "License management. Use the CMC license page.",
  },
  {
    prefix: "/api/v1.0/onpremise/users",
    hint: "Cluster user management. Use the CMC users page.",
  },
  {
    prefix: "/api/v1.0/onpremise/groups",
    hint: "Cluster group management. Use the CMC groups page.",
  },
  {
    prefix: "/api/v1.0/onpremise/sso",
    hint: "SSO / OIDC configuration. Use the CMC SSO page.",
  },
  {
    prefix: "/api/v1.0/onpremise/security",
    hint: "Cluster security settings (mTLS, cipher suites). Use the CMC.",
  },
  {
    prefix: "/api/v1.0/onpremise/backup",
    hint: "Backup / restore. Use the CMC.",
  },
  {
    prefix: "/api/v1.0/onpremise/firewallManagement",
    hint: "Firewall config. Use the CMC.",
  },
  {
    prefix: "/api/v1/cluster/configuration",
    hint: "Cluster-wide configuration. Use the CMC.",
  },
];

export interface DenyDecision {
  denied: boolean;
  reason?: string;
  hint?: string;
  matchedPrefix?: string;
}

/**
 * Normalize the path (lower-case, strip query, leading slash) and check
 * against every deny prefix. Returns { denied:false } when safe.
 */
export function checkClusterDenyList(rawPath: string): DenyDecision {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { denied: false };
  }
  // Strip query/fragment, lowercase, trim — keep slashes
  let p = rawPath.split("?")[0]!.split("#")[0]!.toLowerCase().trim();
  // If caller pasted a full URL, keep just the path
  const protoIdx = p.indexOf("://");
  if (protoIdx !== -1) {
    const afterProto = p.slice(protoIdx + 3);
    const firstSlash = afterProto.indexOf("/");
    p = firstSlash === -1 ? "/" : afterProto.slice(firstSlash);
  }
  // Ensure leading slash for predictable prefix match
  if (!p.startsWith("/")) p = "/" + p;

  for (const { prefix, hint } of CLUSTER_DENY_PREFIXES) {
    if (p.startsWith(prefix.toLowerCase())) {
      return {
        denied: true,
        reason: `path '${rawPath}' is on the cluster-admin deny-list (prefix '${prefix}'). The raw tools refuse cluster-admin writes; this is a hard block with no override.`,
        hint,
        matchedPrefix: prefix,
      };
    }
  }
  return { denied: false };
}

/**
 * Build a ready-to-return ToolResult for a denied path. Also logs a warn.
 */
export function denyResponse(tool: string, decision: DenyDecision): ToolResult {
  log.warn("cluster-admin path denied", {
    tool,
    matchedPrefix: decision.matchedPrefix,
  });
  return textResult(
    {
      refused: true,
      reason: decision.reason,
      hint: decision.hint,
      suggestion:
        "If you need a cluster-admin change, do it through the Cluster Management Console UI and use this MCP only for tenant-scoped writes.",
    },
    true
  );
}
