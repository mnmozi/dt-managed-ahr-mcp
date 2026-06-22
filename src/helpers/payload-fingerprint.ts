/**
 * Payload fingerprinting for create-* tools.
 *
 * The problem: `dt_create_*` does a real write and then returns. If the call
 * times out (despite the dt-client retry layer), the caller has NO way to
 * know whether the create succeeded server-side. The honest behavior is to
 * retry the create — and that produces a duplicate.
 *
 * The fix: every create writes a sha256 fingerprint of the canonicalized
 * payload into the audit log. On the next create with the SAME fingerprint
 * within a short window, we warn the caller — they may already have the
 * object they're about to create again.
 *
 * We don't refuse — a true duplicate may be intentional (e.g. cloning a
 * dashboard). The warning is structured + visible in the response so the
 * caller can stop and verify.
 */

import { createHash } from "node:crypto";
import type { AuditLog, AuditRecord } from "../audit.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("payload-fingerprint");

/** Window in milliseconds within which a duplicate fingerprint counts. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export interface DuplicateCheck {
  /** sha256-hex-12-char prefix of the canonical payload. */
  fingerprint: string;
  /** True iff an earlier audit row for the same tool within the window has the same fingerprint. */
  isDuplicate: boolean;
  /** The matching prior record, if any. */
  priorRecord?: AuditRecord;
  /** Human-readable note for the response payload. */
  warning?: string;
}

/**
 * Canonicalize a value to JSON with sorted object keys so { a:1, b:2 } and
 * { b:2, a:1 } hash the same. Arrays preserve order (semantically meaningful).
 */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
      .join(",") +
    "}"
  );
}

/** sha256 truncated to 16 hex chars — collision-safe enough for this use. */
export function fingerprintOf(payload: unknown): string {
  const canon = canonicalJSON(payload);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/**
 * Check whether the audit log already has a same-fingerprint create from
 * this tool within DUPLICATE_WINDOW_MS. Returns the decision + the
 * fingerprint to log into the new audit row.
 */
export function checkDuplicatePayload(
  audit: AuditLog,
  tool: string,
  payload: unknown,
  now: Date = new Date(),
  windowMs: number = DUPLICATE_WINDOW_MS
): DuplicateCheck {
  const fingerprint = fingerprintOf(payload);
  const recents = audit.recentForTool(tool, 500);
  const cutoff = now.getTime() - windowMs;

  for (const rec of recents) {
    if (rec.payloadFingerprint !== fingerprint) continue;
    const ts = Date.parse(rec.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    // Found a same-fingerprint write within the window.
    log.warn("possible duplicate create detected", {
      tool,
      fingerprint,
      priorTimestamp: rec.timestamp,
      priorStatus: rec.status,
    });
    const minutesAgo = ((now.getTime() - ts) / 60000).toFixed(1);
    return {
      fingerprint,
      isDuplicate: true,
      priorRecord: rec,
      warning: `An identical payload was submitted to ${tool} ${minutesAgo} minutes ago (status ${String(rec.status)}). If the previous call returned an error or timed out, the object may have been created server-side anyway — verify before retrying. Pass acknowledgeDuplicate:true to proceed.`,
    };
  }

  return { fingerprint, isDuplicate: false };
}
