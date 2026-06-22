/**
 * "Object with this name already exists" pre-check for create-settings.
 *
 * Dynatrace's POST /api/v2/settings/objects will happily create a SECOND
 * object with the same display name in the same scope — most schemas don't
 * enforce uniqueness server-side. The duplicate then shows up in the UI as
 * two identically-named entries, and the caller's automation may attach
 * tags / rules to whichever id comes back first, leading to silent drift.
 *
 * This helper lists existing objects with the same schemaId in the same
 * scope and looks for a name collision. It only RUNS when the schema has a
 * known display-name field (a curated allow-list — every schema names its
 * display field differently). For unknown schemas we skip silently and
 * return ok:true (the pre-validate step will still catch hard errors).
 *
 * Returns:
 *   - { ok: true }           when no collision (or schema has no known name field)
 *   - { ok: false, ... }     when a collision is detected
 */

import type { DtClient } from "../dt-client.js";
import { DtApiError } from "../dt-client.js";
import { textResult, type ToolResult } from "./tool-result.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("already-exists");

/**
 * Map of schemaId → the dotted path inside `value` where the human display
 * name lives. Extend as we encounter more schemas. Order doesn't matter.
 */
export const NAME_FIELD_BY_SCHEMA: Record<string, string> = {
  "builtin:management-zones": "name",
  "builtin:alerting.profile": "name",
  "builtin:tags.auto-tagging": "name",
  "builtin:problem.notifications": "displayName",
  "builtin:anomaly-detection.metric-events": "summary",
  "builtin:logmonitoring.log-events": "summary",
  "builtin:span-event-extraction": "name",
  "builtin:opentelemetry-metrics": "name",
};

export interface ExistsConflict {
  schemaId: string;
  scope: string;
  name: string;
  existingObjectId: string;
}

export interface AlreadyExistsOk {
  ok: true;
  /** Items we skipped because their schema isn't in NAME_FIELD_BY_SCHEMA. */
  skippedItems?: number[];
}

export interface AlreadyExistsConflict {
  ok: false;
  conflicts: ExistsConflict[];
  refusal: ToolResult;
}

export interface SettingsObjectLite {
  schemaId: string;
  scope: string;
  value: Record<string, unknown>;
}

/**
 * For each item, if its schema has a known name field AND the item's value
 * carries that name, query the existing objects in the same scope and look
 * for a collision. Returns the first set of conflicts (one per colliding
 * item) — the caller refuses the whole batch.
 */
export async function checkAlreadyExists(
  client: DtClient,
  tool: string,
  items: SettingsObjectLite[]
): Promise<AlreadyExistsOk | AlreadyExistsConflict> {
  const conflicts: ExistsConflict[] = [];
  const skippedItems: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const nameField = NAME_FIELD_BY_SCHEMA[item.schemaId];
    if (!nameField) {
      skippedItems.push(i);
      continue;
    }
    const incomingName = item.value[nameField];
    if (typeof incomingName !== "string" || incomingName.length === 0) {
      skippedItems.push(i);
      continue;
    }

    // Query existing objects in the same schema+scope. Page sizes are
    // capped by Dynatrace; the default returns up to 100 which is plenty
    // for collision detection in practice. We stop after the first page —
    // if there are more, the cluster is probably already badly cluttered
    // and the caller has bigger problems.
    let existing: Array<{ objectId?: string; value?: Record<string, unknown> }> = [];
    try {
      const resp = await client.get<{
        items?: Array<{ objectId?: string; value?: Record<string, unknown> }>;
      }>("/api/v2/settings/objects", {
        query: {
          schemaIds: item.schemaId,
          scopes: item.scope,
          fields: "objectId,value",
          pageSize: 500,
        },
      });
      existing = resp.items ?? [];
    } catch (err) {
      if (err instanceof DtApiError) {
        log.warn("already-exists list query failed; skipping check for this item", {
          tool,
          schemaId: item.schemaId,
          scope: item.scope,
          status: err.status,
        });
      } else {
        log.warn("already-exists list query errored; skipping check for this item", {
          tool,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      skippedItems.push(i);
      continue;
    }

    for (const ex of existing) {
      const exName = ex.value?.[nameField];
      if (typeof exName === "string" && exName === incomingName) {
        conflicts.push({
          schemaId: item.schemaId,
          scope: item.scope,
          name: incomingName,
          existingObjectId: ex.objectId ?? "<unknown>",
        });
        break; // one match is enough
      }
    }
  }

  if (conflicts.length === 0) {
    return { ok: true, skippedItems: skippedItems.length > 0 ? skippedItems : undefined };
  }

  log.warn("already-exists conflict detected; refusing create", {
    tool,
    conflictCount: conflicts.length,
  });
  return {
    ok: false,
    conflicts,
    refusal: textResult(
      {
        created: false,
        refused: true,
        reason: `name collision: ${conflicts.length} of ${items.length} item(s) already exist in the target scope with the same name. Use dt_update_settings on the existing objectId (returned below) instead, or pick a different name. Pass skipExistsCheck:true to bypass (rarely correct).`,
        conflicts,
      },
      true
    ),
  };
}
