import { DtApiError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { mutateAndAudit } from "./mutate-and-audit.js";
import { type ToolResult, refuse } from "./tool-result.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("safe-delete");

/**
 * Generic safe-delete: pre-fetch → optional sanity check → DELETE → audit.
 *
 * The same pattern shows up in delete-settings, delete-dashboard, delete-slo,
 * delete-synthetic-monitor, delete-token — five copies of ~80 lines that
 * drifted while each was being written. Centralized here.
 *
 * The pre-fetch result is captured into the audit log so the deletion is
 * reversible (the caller can re-create using the prior body).
 *
 * `force: true` is dangerous — it skips both the pre-fetch and any sanity
 * check (expectedName / expectedSchemaId), and there is no audit record of
 * the prior object so the delete is NOT reversible. We require an explicit
 * `acknowledgeForce: true` companion flag AND emit a warn-level log so the
 * use is visible in operator dashboards. Without the acknowledgment, `force`
 * alone refuses.
 *
 * @param fetchPath          path to GET the object (env-scoped). On 404 we refuse.
 * @param deletePath         path to DELETE (env-scoped). Usually == fetchPath.
 * @param tool               tool name for audit + the WriteNotEnabledError message.
 * @param objectId           the id of the thing being deleted, for the audit row.
 * @param force              skip the pre-fetch + sanity check entirely. Dangerous.
 * @param acknowledgeForce   MUST be true when force is true — proves the caller knows.
 * @param sanityCheck        optional function called with the fetched object;
 *                           returns null on pass, an error string on fail.
 * @param priorBodyKey       key under which the audit-log requestBody captures
 *                           the prior object (e.g. "priorSlo", "priorDashboard").
 * @param notFoundLabel      what to call the object in the not-found error.
 * @param reversibleHint     string describing how to recreate (shown to caller).
 */
export interface SafeDeleteArgs {
  client: DtClient;
  audit: AuditLog;
  tool: string;
  fetchPath: string;
  deletePath: string;
  objectId: string;
  force?: boolean;
  /** Required when force=true. Without it, force is rejected. */
  acknowledgeForce?: boolean;
  sanityCheck?: (prior: unknown) => string | null;
  priorBodyKey: string;
  notFoundLabel: string;
  reversibleHint?: string;
  /** Extra fields to spread into the success result (e.g. priorName for visibility). */
  extraSuccess?: (prior: unknown) => Record<string, unknown>;
}

export async function safeDelete(args: SafeDeleteArgs): Promise<ToolResult> {
  const {
    client,
    audit,
    tool,
    fetchPath,
    deletePath,
    objectId,
    force,
    acknowledgeForce,
    sanityCheck,
    priorBodyKey,
    notFoundLabel,
    reversibleHint,
    extraSuccess,
  } = args;

  // Escalated confirm: `force` alone is not enough.
  if (force && !acknowledgeForce) {
    return refuse(
      "force:true skips the pre-fetch + sanity check AND skips the reversible-audit capture. To proceed, re-call with both force:true AND acknowledgeForce:true. Prefer NOT to force — pass expectedName/expectedSchemaId instead."
    );
  }
  if (force && acknowledgeForce) {
    log.warn("safe-delete invoked with force=true (no reversibility)", {
      tool,
      objectId,
      deletePath,
    });
  }

  let priorObject: unknown = null;

  if (!force) {
    try {
      priorObject = await client.get<unknown>(fetchPath);
    } catch (err) {
      if (err instanceof DtApiError && err.status === 404) {
        return refuse(`${notFoundLabel} not found (404)`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return refuse(
        `pre-flight fetch failed (${msg}); pass force:true + acknowledgeForce:true to skip the safety check`
      );
    }
    if (sanityCheck) {
      const failReason = sanityCheck(priorObject);
      if (failReason) return refuse(failReason);
    }
  }

  return mutateAndAudit({
    tool,
    method: "DELETE",
    action: () => client.delete(tool, deletePath),
    audit,
    requestBody: { [priorBodyKey]: priorObject },
    objectId,
    successKey: "deleted",
    shapeSuccess: (_data, status) => ({
      deleted: true,
      status,
      objectId,
      ...(extraSuccess ? extraSuccess(priorObject) : {}),
      ...(reversibleHint ? { reversibleVia: reversibleHint } : {}),
    }),
  });
}
