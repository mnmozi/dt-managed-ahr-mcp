/**
 * Pre-flight validation for Settings 2.0 writes.
 *
 * Wraps POST /api/v2/settings/objects?validateOnly=true. The endpoint answers
 * with a per-item response array; each item has either:
 *   - { code: 200|201, objectId? }  → would-succeed
 *   - { code, error: { code, message, constraintViolations? }, invalidValue }
 *
 * The HTTP status depends on the mix (observed live on Managed 1.350.7):
 *   - all items valid   → 200
 *   - mixed             → 207, array in the body
 *   - every item fails  → the items' own 4xx (400 / 404), array STILL in the
 *     body — this is the common single-object case, so the error path must
 *     parse the array too or the per-item violations are lost.
 * Only a body that isn't an item array is treated as a batch-level failure.
 *
 * Dynatrace's messages for unavailable schemas / wrong scopes are opaque
 * ("No schema with topic identifier 'Not allowed for non-DPS license'",
 * 404 "No write access for scope class PROCESS_GROUP"); each invalid item
 * carries a `hint` translating the known ones.
 */
import type { DtClient } from "../dt-client.js";
import { DtApiError } from "../dt-client.js";
import { textResult, type ToolResult } from "./tool-result.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("settings-validate");

export interface SettingsPayload {
  schemaId: string;
  scope: string;
  value: Record<string, unknown>;
}

interface ConstraintViolation {
  path?: string;
  message?: string;
  [k: string]: unknown;
}

export interface ValidateItem {
  code?: number;
  objectId?: string;
  invalidValue?: unknown;
  error?: {
    code?: number;
    message?: string;
    constraintViolations?: ConstraintViolation[];
  };
}

export interface InvalidItem {
  index: number;
  schemaId: string;
  scope: string;
  error: ValidateItem["error"] | string;
  hint?: string;
}

/** Outcome of one validateOnly call, shared by dt_validate_settings and the create pre-check. */
export type ValidateOutcome =
  | { kind: "items"; status: number; items: ValidateItem[]; invalid: InvalidItem[] }
  | { kind: "api-error"; status: number; body: string }
  | { kind: "transport"; message: string };

const HINTS: Array<[RegExp, string]> = [
  [
    /not supported for managed deployments/i,
    "This schema exists only on SaaS — it cannot be written on Managed.",
  ],
  [
    /non-DPS license/i,
    "This schema needs a DPS license; this cluster uses classic licensing, so it cannot be written here.",
  ],
  [
    /No schema with topic identifier|Configuration schema .* does not exist/i,
    "This cluster does not advertise the schema id (renamed or removed in this version). Find the current id with dt_list_schemas.",
  ],
  [
    /No write access for scope class/i,
    "The scope type is not allowed for this schema (Dynatrace reports it as a 404). Check allowedScopes with dt_get_schema and pick an allowed scope.",
  ],
];

const UNKNOWN_PROPERTY_HINT =
  "A field is not part of the schema version this cluster runs — compare the payload with dt_get_schema.";

/** Plain-language hint for a known opaque Dynatrace validation message. */
export function hintFor(error: ValidateItem["error"] | undefined): string | undefined {
  const message = error?.message ?? "";
  for (const [re, hint] of HINTS) if (re.test(message)) return hint;
  if ((error?.constraintViolations ?? []).some((v) => /Unknown property/i.test(v.message ?? ""))) {
    return UNKNOWN_PROPERTY_HINT;
  }
  return undefined;
}

/** The per-item array from a validateOnly body, or null if the body is something else. */
export function parseItemArray(body: unknown, expectedLength: number): ValidateItem[] | null {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) return null;
  if (!parsed.every((it) => it && typeof it === "object" && ("code" in it || "error" in it))) {
    return null;
  }
  return parsed as ValidateItem[];
}

export function collectInvalidItems(items: ValidateItem[], body: SettingsPayload[]): InvalidItem[] {
  const invalid: InvalidItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const base = { index: i, schemaId: body[i]?.schemaId ?? "?", scope: body[i]?.scope ?? "?" };
    if (it.error) {
      const hint = hintFor(it.error);
      invalid.push({ ...base, error: it.error, ...(hint ? { hint } : {}) });
    } else if (it.code && (it.code < 200 || it.code >= 300)) {
      invalid.push({ ...base, error: `unexpected validate code ${it.code}` });
    }
  }
  return invalid;
}

/** POST …?validateOnly=true and classify the answer. Never throws. */
export async function validateSettingsBatch(
  client: DtClient,
  tool: string,
  body: SettingsPayload[]
): Promise<ValidateOutcome> {
  try {
    const { status, data } = await client.post<unknown>(tool, "/api/v2/settings/objects", body, {
      query: { validateOnly: true },
    });
    // A non-array success body is treated as "no per-item errors".
    const items = Array.isArray(data) ? (data as ValidateItem[]) : [];
    return { kind: "items", status, items, invalid: collectInvalidItems(items, body) };
  } catch (err) {
    if (err instanceof DtApiError) {
      const items = parseItemArray(err.body, body.length);
      if (items) {
        return { kind: "items", status: err.status, items, invalid: collectInvalidItems(items, body) };
      }
      return { kind: "api-error", status: err.status, body: err.body };
    }
    return { kind: "transport", message: err instanceof Error ? err.message : String(err) };
  }
}

export interface ValidateOk {
  ok: true;
  rawResponse: unknown;
}

export interface ValidateFailed {
  ok: false;
  refusal: ToolResult;
  invalidItems: InvalidItem[];
}

export async function preValidateSettings(
  client: DtClient,
  tool: string,
  body: SettingsPayload[]
): Promise<ValidateOk | ValidateFailed> {
  const outcome = await validateSettingsBatch(client, tool, body);

  if (outcome.kind === "items") {
    const invalid = outcome.invalid;
    if (invalid.length === 0) {
      log.debug("pre-validate ok", { tool, items: body.length });
      return { ok: true, rawResponse: outcome.items };
    }
    log.warn("pre-validate found invalid items; refusing create", {
      tool,
      invalidCount: invalid.length,
      totalItems: body.length,
    });
    return {
      ok: false,
      invalidItems: invalid,
      refusal: textResult(
        {
          created: false,
          refused: true,
          reason: `pre-validate refused: ${invalid.length} of ${body.length} item(s) would fail Dynatrace's validation. Fix the listed items (or re-fetch dt_get_schema to see field shape) and retry.`,
          invalidItems: invalid,
          note:
            "Pre-validate uses POST /api/v2/settings/objects?validateOnly=true so no objects were created. Pass skipPreValidate:true to bypass (not recommended).",
        },
        true
      ),
    };
  }

  if (outcome.kind === "api-error") {
    // The validate API rejected the batch without per-item results (grossly
    // malformed payload, auth, 5xx). Fail closed rather than send an untested
    // payload.
    log.warn("pre-validate API rejected the call; refusing create", {
      tool,
      status: outcome.status,
      bodyPreview: outcome.body.slice(0, 200),
    });
    return {
      ok: false,
      invalidItems: [
        {
          index: -1,
          schemaId: "<batch>",
          scope: "<batch>",
          error: `validate API returned HTTP ${outcome.status}: ${outcome.body.slice(0, 500)}`,
        },
      ],
      refusal: textResult(
        {
          created: false,
          refused: true,
          reason:
            "pre-validate failed at the API layer — refusing to attempt the create. Inspect the error body to fix the payload, then retry.",
          validateApiStatus: outcome.status,
          validateApiBody: outcome.body.slice(0, 2000),
          note: "Pass skipPreValidate:true to bypass the pre-validate step (not recommended).",
        },
        true
      ),
    };
  }

  log.error("pre-validate transport error; refusing create", { tool, error: outcome.message });
  return {
    ok: false,
    invalidItems: [{ index: -1, schemaId: "<batch>", scope: "<batch>", error: outcome.message }],
    refusal: textResult(
      {
        created: false,
        refused: true,
        reason: `pre-validate failed at the transport layer (${outcome.message}). Refusing to create. Retry once the cluster is reachable, or pass skipPreValidate:true to bypass.`,
      },
      true
    ),
  };
}
