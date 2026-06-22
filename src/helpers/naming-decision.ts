/**
 * Naming-decision lattice validator.
 *
 * Every dt_apply_*_naming_* write enforces the same lattice:
 *
 *   bucket            allowed deciders
 *   ─────────────────────────────────────────────────────────────────────
 *   high_confidence   engine_high (chosenName must equal topCandidate),
 *                     operator_override (warn-logged + flagged in response)
 *   ambiguous         ai_proposed (chosenName must be IN engine candidates
 *                     AND aiRationale must be non-empty),
 *                     operator_confirmed (chosenName must be IN candidates),
 *                     operator_override (warn-logged)
 *   no_signal         operator_override ONLY. ai_proposed and engine_high
 *                     are rejected — AI cannot upgrade a bucket.
 *
 * This is enforced in code so it's not a trust convention. The decision
 * lives in the audit log as a NamingDecisionRecord for full provenance.
 */

import type { NamingCandidate, NamingDecision, EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";
import type { NamingDecisionRecord } from "../audit.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("naming-decision");

export type Decider = NamingDecisionRecord["decider"];

/** What the caller submits per entity. */
export interface ProposedDecision {
  entityId: string;
  chosenName: string;
  source: Decider;
  aiRationale?: string;
}

export interface DecisionValidationOk {
  ok: true;
  record: NamingDecisionRecord;
}

export interface DecisionValidationError {
  ok: false;
  reason: string;
}

/**
 * Validate one ProposedDecision against the engine's report for the same
 * entityId. Returns the audit record on success, an error string on
 * lattice violation.
 */
export function validateDecision(
  proposed: ProposedDecision,
  report: EntityNamingReport | undefined
): DecisionValidationOk | DecisionValidationError {
  if (!report) {
    return {
      ok: false,
      reason: `no engine report found for entityId='${proposed.entityId}'. Re-run dt_audit_process_group_naming and pass decisions whose entityIds appear in the latest report.`,
    };
  }

  const candNames = new Set(report.candidates.map((c) => c.name));

  switch (proposed.source) {
    case "engine_high": {
      if (report.decision !== "high_confidence") {
        return {
          ok: false,
          reason: `decider 'engine_high' is only valid for bucket='high_confidence'; entity ${proposed.entityId} is bucket='${report.decision}'. AI cannot upgrade a bucket.`,
        };
      }
      if (proposed.chosenName !== report.topCandidate) {
        return {
          ok: false,
          reason: `decider 'engine_high' requires chosenName to equal topCandidate ('${report.topCandidate}'); got '${proposed.chosenName}'.`,
        };
      }
      break;
    }
    case "ai_proposed": {
      if (report.decision !== "ambiguous") {
        return {
          ok: false,
          reason: `decider 'ai_proposed' is only valid for bucket='ambiguous'; entity ${proposed.entityId} is bucket='${report.decision}'. AI cannot propose for high_confidence (use engine_high) or no_signal (operator only).`,
        };
      }
      if (!candNames.has(proposed.chosenName)) {
        return {
          ok: false,
          reason: `decider 'ai_proposed' requires chosenName to be in the engine's candidate list (${[...candNames].join(", ") || "<empty>"}); got '${proposed.chosenName}'. AI cannot invent names.`,
        };
      }
      if (!proposed.aiRationale || proposed.aiRationale.trim().length === 0) {
        return {
          ok: false,
          reason: `decider 'ai_proposed' requires a non-empty aiRationale explaining the pick.`,
        };
      }
      break;
    }
    case "operator_confirmed": {
      if (report.decision === "no_signal") {
        return {
          ok: false,
          reason: `decider 'operator_confirmed' is not valid for bucket='no_signal' (no candidates to confirm); use 'operator_override' to supply a manual name.`,
        };
      }
      if (!candNames.has(proposed.chosenName)) {
        return {
          ok: false,
          reason: `decider 'operator_confirmed' requires chosenName to be in the engine's candidate list; got '${proposed.chosenName}'. Use 'operator_override' to supply a name not in the slate.`,
        };
      }
      break;
    }
    case "operator_override": {
      // Always allowed — but logged loudly.
      log.warn("operator override accepted (engine candidates bypassed)", {
        entityId: proposed.entityId,
        bucket: report.decision,
        chosenName: proposed.chosenName,
        engineTopCandidate: report.topCandidate,
      });
      break;
    }
    default: {
      // exhaustiveness: TypeScript catches at compile time, but defend at runtime.
      return {
        ok: false,
        reason: `unknown decider '${String(proposed.source)}'. Valid values: engine_high, ai_proposed, operator_confirmed, operator_override.`,
      };
    }
  }

  const record: NamingDecisionRecord = {
    entityId: proposed.entityId,
    bucket: report.decision,
    decider: proposed.source,
    chosenName: proposed.chosenName,
    engineCandidates: report.candidates.map((c: NamingCandidate) => ({
      source: c.source,
      name: c.name,
      confidence: c.confidence,
    })),
    aiRationale: proposed.aiRationale,
  };
  return { ok: true, record };
}

/** Pretty-print the bucket+decider combination for response payloads. */
export function describeDecision(record: NamingDecisionRecord): string {
  return `[${record.bucket} / ${record.decider}] '${record.chosenName}'`;
}

/** Helper for callers — coerce engine's NamingDecision string union. */
export function isValidNamingDecision(v: string): v is NamingDecision {
  return v === "high_confidence" || v === "ambiguous" || v === "no_signal";
}
