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
  const { client, audit, tool, reports, decisions } = args;

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
            note:
              failedCount > 0
                ? "Some decisions failed per-entity (see results[]). The lattice validation passed for all — these failures are HTTP-level."
                : "All decisions written. Downstream tag-strategy rules can now target tag(name:<chosenName>).",
          },
          null,
          2
        ),
      },
    ],
    isError: failedCount > 0,
  };
}
