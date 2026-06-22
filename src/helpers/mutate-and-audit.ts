import { DtApiError, WriteNotEnabledError } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { type ToolResult, refuse, textResult } from "./tool-result.js";

/**
 * Run a mutating action, audit success or failure, normalize to a ToolResult.
 *
 * Every write tool used to copy ~30 lines of try/catch/audit boilerplate.
 * This helper is the centralized version — change retry/redaction/format
 * once, every write tool inherits it.
 *
 * Caller responsibilities:
 *  - check confirm BEFORE calling (this helper doesn't — the caller's tool
 *    description may have other guards that should fire first)
 *  - shape requestBody for the audit log; sensitive fields (token values,
 *    passwords) should already be redacted in `requestBody` if needed
 *  - choose `successKey` (e.g. "created", "updated", "deleted", "posted")
 *    so the response shape matches the tool's name
 */
export interface MutateAndAuditArgs<T> {
  tool: string;
  method: string;
  action: () => Promise<{ status: number; path: string; data: T }>;
  audit: AuditLog;
  /** What we record in the audit log as the request payload (post-redaction if needed). */
  requestBody: unknown;
  /** Optional object id to tag the audit row with. */
  objectId?: string;
  /** Optional schema id to tag the audit row with. */
  schemaId?: string;
  /** Key in the success response payload — e.g. "created", "updated", "deleted". */
  successKey: string;
  /** Optional transform on the success response before returning (e.g. extract token, redact in audit). */
  shapeSuccess?: (data: T, status: number) => Record<string, unknown>;
}

export async function mutateAndAudit<T = unknown>(
  args: MutateAndAuditArgs<T>
): Promise<ToolResult> {
  const { tool, method, action, audit, requestBody, objectId, schemaId, successKey, shapeSuccess } = args;

  try {
    const { status, path, data } = await action();
    audit.write({
      timestamp: new Date().toISOString(),
      tool,
      method,
      path,
      validateOnly: false,
      objectId,
      schemaId,
      status,
      requestBody,
      responseBody: data,
    });
    const successBody = shapeSuccess
      ? shapeSuccess(data, status)
      : { [successKey]: true, status, response: data };
    return textResult(successBody);
  } catch (err) {
    if (err instanceof WriteNotEnabledError) {
      return textResult(err.message, true);
    }
    if (err instanceof DtApiError) {
      audit.write({
        timestamp: new Date().toISOString(),
        tool,
        method,
        path: err.path,
        validateOnly: false,
        objectId,
        schemaId,
        status: err.status,
        requestBody,
        error: err.body,
      });
      return textResult(
        { [successKey]: false, status: err.status, error: err.body },
        true
      );
    }
    throw err;
  }
}

/** Re-export `refuse` for handlers that want a one-liner. */
export { refuse };
