/**
 * Blast-radius pre-check for tools that mutate entities matched by an
 * entitySelector. Prevents the foot-gun where a too-broad selector silently
 * affects thousands of entities.
 *
 * The check:
 *  1. Pre-fetches the matched count via /api/v2/entities (pageSize=1).
 *  2. Refuses if 0 entities match (silent no-op is hostile).
 *  3. Refuses if matched count is above the "require acknowledgment" threshold
 *     AND the caller didn't pass expectedMatchCount.
 *  4. If expectedMatchCount was passed, refuses when actual diverges from
 *     expected by more than the tolerance (default 5%).
 *  5. Refuses if matched count is above the "mass change" threshold AND
 *     acknowledgeMassChange wasn't set.
 *
 * Returns either { ok: true, matchedCount } (proceed) or a ready-to-return
 * ToolResult containing the refusal reason. The caller does:
 *
 *   const check = await checkBlastRadius({ client, entitySelector, ... });
 *   if (!check.ok) return check.refusal;
 *   // ... proceed with check.matchedCount visible for logging / response
 */

import type { DtClient } from "../dt-client.js";
import { textResult, type ToolResult } from "./tool-result.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("blast-radius");

/** Default thresholds — exposed as exports for tests / docs. */
export const DEFAULT_ACK_ABOVE = 10;
export const DEFAULT_MASS_ABOVE = 1000;
export const DEFAULT_TOLERANCE = 0.05;
/** How many entity names to surface as a preview in success + refusal responses. */
export const DEFAULT_PREVIEW_SIZE = 5;

export interface BlastRadiusArgs {
  client: DtClient;
  tool: string; // for logging
  entitySelector: string;
  expectedMatchCount?: number;
  acknowledgeMassChange?: boolean;
  from?: string;
  to?: string;
  /** Override default. Required when match count exceeds this AND expectedMatchCount missing. */
  ackAbove?: number;
  /** Override default. Required acknowledgeMassChange when match count exceeds this. */
  massAbove?: number;
  /** Override default. Fraction of |actual-expected|/expected we tolerate. */
  tolerance?: number;
  /** Override default. Number of entity {id, name} pairs to include as a preview. */
  previewSize?: number;
}

export interface EntityPreview {
  entityId: string;
  displayName: string | null;
}

export interface BlastRadiusOk {
  ok: true;
  matchedCount: number;
  /** First N entities (id + name) so the caller can sanity-check the selector. */
  preview: EntityPreview[];
}

export interface BlastRadiusRefused {
  ok: false;
  refusal: ToolResult;
  matchedCount?: number;
  preview?: EntityPreview[];
  reason: string;
}

export async function checkBlastRadius(
  args: BlastRadiusArgs
): Promise<BlastRadiusOk | BlastRadiusRefused> {
  const ackAbove = args.ackAbove ?? DEFAULT_ACK_ABOVE;
  const massAbove = args.massAbove ?? DEFAULT_MASS_ABOVE;
  const tolerance = args.tolerance ?? DEFAULT_TOLERANCE;
  const previewSize = Math.max(0, args.previewSize ?? DEFAULT_PREVIEW_SIZE);

  let matchedCount: number;
  let preview: EntityPreview[] = [];
  try {
    // Single round-trip: ask for `previewSize` results AND let totalCount come
    // back. Dynatrace returns both — no need for a separate count call.
    const resp = await args.client.get<{
      totalCount?: number;
      entities?: Array<{ entityId?: string; displayName?: string }>;
    }>("/api/v2/entities", {
      query: {
        entitySelector: args.entitySelector,
        from: args.from ?? "now-24h",
        to: args.to ?? "now",
        pageSize: previewSize > 0 ? previewSize : 1,
        fields: "entityId,displayName",
      },
    });
    matchedCount = resp.totalCount ?? 0;
    preview = (resp.entities ?? [])
      .slice(0, previewSize)
      .map((e) => ({
        entityId: typeof e.entityId === "string" ? e.entityId : "",
        displayName: typeof e.displayName === "string" ? e.displayName : null,
      }))
      .filter((e) => e.entityId.length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("blast-radius pre-check failed; refusing", {
      tool: args.tool,
      entitySelector: args.entitySelector,
      error: msg,
    });
    return {
      ok: false,
      reason: "selector pre-check failed",
      refusal: textResult(
        {
          refused: true,
          reason:
            "could not pre-check entitySelector — refusing to mutate without knowing blast radius",
          error: msg,
          entitySelector: args.entitySelector,
        },
        true
      ),
    };
  }

  // Rule 1: zero matches → refuse (silent no-op is a real bug surface)
  if (matchedCount === 0) {
    log.warn("blast-radius zero matches; refusing", {
      tool: args.tool,
      entitySelector: args.entitySelector,
    });
    return {
      ok: false,
      matchedCount,
      preview: [],
      reason: "no entities match",
      refusal: textResult(
        {
          refused: true,
          reason:
            "selector matches 0 entities — nothing to mutate. Check the selector. (If you intended to verify the selector, use dt_search_entities.)",
          entitySelector: args.entitySelector,
          matchedCount: 0,
        },
        true
      ),
    };
  }

  // Rule 2: above ack threshold AND expectedMatchCount missing → refuse with the count
  if (matchedCount > ackAbove && args.expectedMatchCount === undefined) {
    log.warn("blast-radius requires acknowledgment", {
      tool: args.tool,
      entitySelector: args.entitySelector,
      matchedCount,
      ackAbove,
    });
    return {
      ok: false,
      matchedCount,
      preview,
      reason: "expectedMatchCount required",
      refusal: textResult(
        {
          refused: true,
          reason: `selector matches ${matchedCount} entities (above the ${ackAbove}-entity acknowledgment threshold). To proceed, re-call with expectedMatchCount=${matchedCount}.`,
          entitySelector: args.entitySelector,
          matchedCount,
          ackThreshold: ackAbove,
          previewEntities: preview,
          previewNote:
            "First few matched entities shown so you can verify the selector targets the right thing before re-confirming.",
        },
        true
      ),
    };
  }

  // Rule 3: expected provided AND diverges too much → refuse
  if (args.expectedMatchCount !== undefined) {
    const expected = args.expectedMatchCount;
    const denom = Math.max(expected, 1); // avoid divide-by-zero
    const drift = Math.abs(matchedCount - expected) / denom;
    if (drift > tolerance) {
      log.warn("blast-radius expected/actual divergence; refusing", {
        tool: args.tool,
        entitySelector: args.entitySelector,
        matchedCount,
        expected,
        drift,
        tolerance,
      });
      return {
        ok: false,
        matchedCount,
        preview,
        reason: "expected vs actual divergence",
        refusal: textResult(
          {
            refused: true,
            reason: `selector now matches ${matchedCount} entities; caller expected ${expected} (drift ${(drift * 100).toFixed(1)}% > tolerance ${(tolerance * 100).toFixed(1)}%). Cluster state may have changed since you last checked. Re-confirm with the new count.`,
            entitySelector: args.entitySelector,
            matchedCount,
            expectedMatchCount: expected,
            drift,
            tolerance,
            previewEntities: preview,
          },
          true
        ),
      };
    }
  }

  // Rule 4: above mass-change threshold AND no acknowledgeMassChange → refuse
  if (matchedCount > massAbove && !args.acknowledgeMassChange) {
    log.warn("blast-radius mass change without acknowledgement; refusing", {
      tool: args.tool,
      entitySelector: args.entitySelector,
      matchedCount,
      massAbove,
    });
    return {
      ok: false,
      matchedCount,
      preview,
      reason: "acknowledgeMassChange required",
      refusal: textResult(
        {
          refused: true,
          reason: `selector matches ${matchedCount} entities (above the ${massAbove}-entity mass-change threshold). This is a very large mutation. To proceed, re-call with acknowledgeMassChange=true AND expectedMatchCount=${matchedCount}.`,
          entitySelector: args.entitySelector,
          matchedCount,
          massThreshold: massAbove,
          previewEntities: preview,
        },
        true
      ),
    };
  }

  log.info("blast-radius check passed", {
    tool: args.tool,
    entitySelector: args.entitySelector,
    matchedCount,
    previewCount: preview.length,
  });
  return { ok: true, matchedCount, preview };
}
