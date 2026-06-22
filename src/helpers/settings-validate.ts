/**
 * Pre-flight validation for Settings 2.0 writes.
 *
 * Wraps POST /api/v2/settings/objects?validateOnly=true. The endpoint returns
 * 200 with a per-item response array; each item has either:
 *   - { code: 200|201, objectId? }  → would-succeed
 *   - { error: { code, message, constraintViolations? } }  → would-fail
 *
 * Some Dynatrace versions also return overall 400 on grossly malformed
 * payloads; we handle that path too.
 *
 * Returns:
 *   - { ok: true } when every item validates
 *   - { ok: false, refusal } when any item would fail; refusal is a
 *     ready-to-return ToolResult with the structured per-item details
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

interface ValidateItem {
  code?: number;
  objectId?: string;
  invalidValue?: unknown;
  error?: {
    code?: number;
    message?: string;
    constraintViolations?: unknown[];
  };
}

export interface ValidateOk {
  ok: true;
  rawResponse: unknown;
}

export interface ValidateFailed {
  ok: false;
  refusal: ToolResult;
  invalidItems: Array<{
    index: number;
    schemaId: string;
    scope: string;
    error: ValidateItem["error"] | string;
  }>;
}

export async function preValidateSettings(
  client: DtClient,
  tool: string,
  body: SettingsPayload[]
): Promise<ValidateOk | ValidateFailed> {
  try {
    const { data } = await client.post<ValidateItem[] | unknown>(
      tool,
      "/api/v2/settings/objects",
      body,
      { query: { validateOnly: true } }
    );

    const items = Array.isArray(data) ? (data as ValidateItem[]) : [];
    const invalid: ValidateFailed["invalidItems"] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.error) {
        invalid.push({
          index: i,
          schemaId: body[i]?.schemaId ?? "?",
          scope: body[i]?.scope ?? "?",
          error: it.error,
        });
      } else if (it && it.code && (it.code < 200 || it.code >= 300)) {
        invalid.push({
          index: i,
          schemaId: body[i]?.schemaId ?? "?",
          scope: body[i]?.scope ?? "?",
          error: `unexpected validate code ${it.code}`,
        });
      }
    }

    if (invalid.length > 0) {
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

    log.debug("pre-validate ok", { tool, items: body.length });
    return { ok: true, rawResponse: data };
  } catch (err) {
    // Validation API itself failed. Could be 4xx (grossly malformed payload
    // — Dynatrace refuses before per-item validation) or 5xx / network error.
    // Either way: refuse. Better to fail closed than send untested payload.
    if (err instanceof DtApiError) {
      log.warn("pre-validate API rejected the call; refusing create", {
        tool,
        status: err.status,
        bodyPreview: err.body.slice(0, 200),
      });
      return {
        ok: false,
        invalidItems: [
          {
            index: -1,
            schemaId: "<batch>",
            scope: "<batch>",
            error: `validate API returned HTTP ${err.status}: ${err.body.slice(0, 500)}`,
          },
        ],
        refusal: textResult(
          {
            created: false,
            refused: true,
            reason:
              "pre-validate failed at the API layer — refusing to attempt the create. Inspect the error body to fix the payload, then retry.",
            validateApiStatus: err.status,
            validateApiBody: err.body.slice(0, 500),
            note:
              "Pass skipPreValidate:true to bypass the pre-validate step (not recommended).",
          },
          true
        ),
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error("pre-validate transport error; refusing create", {
      tool,
      error: msg,
    });
    return {
      ok: false,
      invalidItems: [
        { index: -1, schemaId: "<batch>", scope: "<batch>", error: msg },
      ],
      refusal: textResult(
        {
          created: false,
          refused: true,
          reason: `pre-validate failed at the transport layer (${msg}). Refusing to create. Retry once the cluster is reachable, or pass skipPreValidate:true to bypass.`,
        },
        true
      ),
    };
  }
}
