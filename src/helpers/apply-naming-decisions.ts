/**
 * Shared write-loop for dt_apply_pg_naming_rule and
 * dt_apply_host_clarifying_tag (and future per-layer variants).
 *
 * Both layers do the same thing under the hood:
 *   1. Validate every decision against the matching engine report via
 *      the lattice (helpers/naming-decision.ts). All-or-nothing.
 *   2. For each validated decision, write a `name:<chosenName>` tag on
 *      the entity (entityId selector), audit with the full
 *      namingDecision provenance block.
 *
 * The tag-based write was chosen for v1 reversibility + schema
 * stability. The mechanism can be swapped per-layer (e.g. a Settings 2.0
 * conditional-naming rule for PGs in v2) without changing the lattice
 * or the audit contract.
 */
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog, NamingDecisionRecord } from "../audit.js";
import type { ToolResult } from "./tool-result.js";
import {
  validateDecision,
  describeDecision,
  type Decider,
} from "./naming-decision.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";

export interface ProposedDecisionInput {
  entityId: string;
  chosenName: string;
  source: Decider;
  aiRationale?: string;
}

export interface ApplyNamingArgs {
  client: DtClient;
  audit: AuditLog;
  /** Tool name — for audit + WriteNotEnabledError messages. */
  tool: string;
  reports: EntityNamingReport[];
  decisions: ProposedDecisionInput[];
  /**
   * When true, after the name:<value> tags are written, ALSO create one
   * Config v1 conditional-naming rule per distinct chosen name — the
   * actual display rename, keyed on the tag. Existing rules with the same
   * nameFormat are detected and skipped (never duplicated).
   */
  createNamingRule?: boolean;
  /** Config v1 conditional-naming type for this entity kind. Required when createNamingRule is set. */
  conditionalNamingType?: "processGroup" | "host" | "service";
}

/** Rule-type + tag-attribute per conditional-naming path. */
const RULE_META: Record<"processGroup" | "host" | "service", { ruleType: string; tagAttr: string }> = {
  processGroup: { ruleType: "PROCESS_GROUP", tagAttr: "PROCESS_GROUP_TAGS" },
  host: { ruleType: "HOST", tagAttr: "HOST_TAGS" },
  service: { ruleType: "SERVICE", tagAttr: "SERVICE_TAGS" },
};

interface RuleResult {
  chosenName: string;
  created: boolean;
  skippedExistingId?: string;
  status?: number;
  error?: string;
}

/**
 * Create conditional-naming rules for the distinct chosen names that were
 * successfully tagged. Dedupe is by nameFormat: we list existing rules and
 * fetch each one's detail (bounded) — if any rule already renames to the
 * same value, we skip (the operator may have created it by hand; observed
 * live: 14 hand-created rules).
 */
async function createConditionalNamingRules(
  client: DtClient,
  audit: AuditLog,
  tool: string,
  type: "processGroup" | "host" | "service",
  names: string[]
): Promise<{ rules: RuleResult[]; dedupeError?: string }> {
  const meta = RULE_META[type];
  const listPath = `/api/config/v1/conditionalNaming/${type}`;

  // Fetch existing nameFormats. On failure we REFUSE to create (duplicates
  // are worse than a skipped optimization) and surface the reason.
  const existingFormats = new Map<string, string>(); // nameFormat -> ruleId
  try {
    const list = await client.get<{ values?: Array<{ id: string; name?: string }> }>(listPath);
    const ids = (list.values ?? []).slice(0, 100);
    for (const v of ids) {
      try {
        const detail = await client.get<{ nameFormat?: string }>(`${listPath}/${encodeURIComponent(v.id)}`);
        if (detail.nameFormat) existingFormats.set(detail.nameFormat, v.id);
      } catch {
        // Unreadable rule — ignore; worst case we skip dedupe for it.
      }
    }
  } catch (err) {
    return {
      rules: [],
      dedupeError: `could not list existing conditional-naming rules (${err instanceof Error ? err.message : String(err)}) — refusing to create rules to avoid duplicates. Create manually or retry.`,
    };
  }

  const rules: RuleResult[] = [];
  for (const name of names) {
    const existing = existingFormats.get(name);
    if (existing) {
      rules.push({ chosenName: name, created: false, skippedExistingId: existing });
      continue;
    }
    // Body shape validated against live rules on Managed 1.342: `rules` is
    // a FLAT array of conditions ({key, comparisonInfo}) — no inner
    // {type, conditions} wrapper — and condition keys carry type STATIC.
    const body = {
      type: meta.ruleType,
      enabled: true,
      displayName: "auto-naming: " + name + " (via name tag)",
      nameFormat: name,
      rules: [
        {
          key: { attribute: meta.tagAttr, type: "STATIC" },
          comparisonInfo: {
            type: "TAG",
            operator: "EQUALS",
            negate: false,
            value: { context: "CONTEXTLESS", key: "name", value: name },
          },
        },
      ],
    };
    try {
      const { status, path, data } = await client.post<unknown>(tool, listPath, body);
      audit.write({
        timestamp: new Date().toISOString(),
        tool,
        method: "POST",
        path,
        validateOnly: false,
        status,
        requestBody: body,
        responseBody: data,
      });
      rules.push({ chosenName: name, created: true, status });
    } catch (err) {
      if (err instanceof DtApiError) {
        audit.write({
          timestamp: new Date().toISOString(),
          tool,
          method: "POST",
          path: err.path,
          validateOnly: false,
          status: err.status,
          requestBody: body,
          error: err.body,
        });
        rules.push({ chosenName: name, created: false, status: err.status, error: err.body.slice(0, 300) });
        continue;
      }
      throw err;
    }
  }
  return { rules };
}

interface PerResult {
  entityId: string;
  chosenName: string;
  decision: string;
  applied: boolean;
  status?: number;
  error?: string;
}

/**
 * Run the full validate-then-write flow and return a ToolResult ready to
 * hand back from the registered MCP tool. Returns isError:true when:
 *   - any decision fails lattice validation (whole batch refused), OR
 *   - any per-entity write fails (other writes still attempted).
 */
export async function applyNamingDecisions(args: ApplyNamingArgs): Promise<ToolResult> {
  const { client, audit, tool, reports, decisions, createNamingRule, conditionalNamingType } = args;

  // Index reports for fast per-decision lookup.
  const reportByEntity = new Map<string, EntityNamingReport>();
  for (const r of reports) reportByEntity.set(r.entityId, r);

  // First pass: validate every decision. All-or-nothing — half-applied
  // state is worse than nothing.
  const validated: Array<{
    entityId: string;
    chosenName: string;
    record: NamingDecisionRecord;
  }> = [];
  const errors: Array<{ entityId: string; reason: string }> = [];
  for (const d of decisions) {
    const v = validateDecision(d, reportByEntity.get(d.entityId));
    if (!v.ok) {
      errors.push({ entityId: d.entityId, reason: v.reason });
    } else {
      validated.push({ entityId: d.entityId, chosenName: d.chosenName, record: v.record });
    }
  }
  if (errors.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              applied: 0,
              refused: true,
              reason: `${errors.length} of ${decisions.length} decision(s) failed lattice validation. No writes performed.`,
              errors,
              note: "The lattice prevents AI from upgrading buckets or inventing names. Fix the offending decisions and retry. (operator_override is always allowed if a manual name is genuinely needed.)",
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Second pass: write tags + audit per entity. Continue on per-entity
  // failure so one bad write doesn't sink the whole batch.
  const results: PerResult[] = [];

  for (const v of validated) {
    const entitySelector = `entityId(${v.entityId})`;
    const tagBody = { tags: [{ key: "name", value: v.chosenName }] };
    try {
      const { status, path, data } = await client.post<{
        matchedEntitiesCount?: number;
      }>(tool, "/api/v2/tags", tagBody, { query: { entitySelector } });
      audit.write({
        timestamp: new Date().toISOString(),
        tool,
        method: "POST",
        path,
        validateOnly: false,
        objectId: v.entityId,
        status,
        requestBody: { entitySelector, body: tagBody },
        responseBody: data,
        namingDecision: v.record,
      });
      results.push({
        entityId: v.entityId,
        chosenName: v.chosenName,
        decision: describeDecision(v.record),
        applied: true,
        status,
      });
    } catch (err) {
      if (err instanceof WriteNotEnabledError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      if (err instanceof DtApiError) {
        audit.write({
          timestamp: new Date().toISOString(),
          tool,
          method: "POST",
          path: err.path,
          validateOnly: false,
          objectId: v.entityId,
          status: err.status,
          requestBody: { entitySelector, body: tagBody },
          error: err.body,
          namingDecision: v.record,
        });
        results.push({
          entityId: v.entityId,
          chosenName: v.chosenName,
          decision: describeDecision(v.record),
          applied: false,
          status: err.status,
          error: err.body.slice(0, 200),
        });
        continue;
      }
      throw err;
    }
  }

  const appliedCount = results.filter((r) => r.applied).length;
  const failedCount = results.length - appliedCount;

  // Optional second step: real display renames via conditional-naming
  // rules, one per distinct successfully-tagged name.
  let namingRules: RuleResult[] | undefined;
  let namingRulesError: string | undefined;
  if (createNamingRule && conditionalNamingType && appliedCount > 0) {
    const names = [...new Set(results.filter((r) => r.applied).map((r) => r.chosenName))];
    const out = await createConditionalNamingRules(client, audit, tool, conditionalNamingType, names);
    namingRules = out.rules;
    namingRulesError = out.dedupeError;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            applied: appliedCount,
            failed: failedCount,
            total: validated.length,
            results,
            ...(namingRules ? { namingRules } : {}),
            ...(namingRulesError ? { namingRulesError } : {}),
            note:
              failedCount > 0
                ? "Some decisions failed per-entity (see results[]). The lattice validation passed for all — these failures are HTTP-level."
                : createNamingRule
                  ? "Tags written. namingRules[] shows the conditional-naming rules created (or skipped as already existing) — display names update on the next entity refresh."
                  : "All decisions written as name:<value> tags. NOTE: this does NOT change display names — pass createNamingRule:true to also create the conditional-naming rules, or create them manually.",
          },
          null,
          2
        ),
      },
    ],
    isError: failedCount > 0,
  };
}
