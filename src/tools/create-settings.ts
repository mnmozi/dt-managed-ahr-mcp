import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DtApiError, WriteNotEnabledError, type DtClient } from "../dt-client.js";
import type { AuditLog } from "../audit.js";
import { preValidateSettings } from "../helpers/settings-validate.js";
import { checkAlreadyExists } from "../helpers/already-exists.js";
import { checkDuplicatePayload } from "../helpers/payload-fingerprint.js";
import { refuse } from "../helpers/mutate-and-audit.js";

const TOOL = "dt_create_settings";

/**
 * POST /api/v2/settings/objects — create one or more Settings 2.0 objects.
 *
 * Three safety nets on top of `confirm: "yes"`:
 *   1. Pre-validate the payload via POST …?validateOnly=true. Refuses with
 *      structured per-item errors if any item would fail. (skipPreValidate)
 *   2. Already-exists check: for schemas with a known display-name field
 *      (alerting profile, MZ, auto-tag rule, …), list existing objects in
 *      the same scope and refuse if an object with the same name is found.
 *      (skipExistsCheck)
 *   3. Payload-fingerprint dedup: if an identical payload was submitted in
 *      the last 10 minutes (likely a retry after a timeout), warn the
 *      caller. (acknowledgeDuplicate to proceed)
 */
export function registerCreateSettings(
  server: McpServer,
  client: DtClient,
  audit: AuditLog
): void {
  server.registerTool(
    TOOL,
    {
      description:
        "Create one or more Settings 2.0 objects on the environment. THREE pre-checks: (1) auto-validate via validateOnly=true [skipPreValidate], (2) name-collision check against existing objects in same scope for known schemas [skipExistsCheck], (3) payload-fingerprint duplicate detection if identical body submitted recently [acknowledgeDuplicate]. REQUIRES confirm='yes'. Requires DT_WRITE_TOKEN. Every call (successful or failed) is appended to the audit log.",
      inputSchema: {
        objects: z
          .array(
            z.object({
              schemaId: z.string().min(1),
              scope: z.string().min(1),
              value: z.record(z.string(), z.unknown()),
            })
          )
          .min(1)
          .describe("Array of settings-object payloads to create."),
        skipPreValidate: z
          .boolean()
          .optional()
          .describe(
            "If true, skip the auto-validate step. Default false — pre-validation catches malformed payloads with structured errors before they hit the real create. Use only when the validate endpoint is misbehaving."
          ),
        skipExistsCheck: z
          .boolean()
          .optional()
          .describe(
            "If true, skip the name-collision check. Default false. Only checks schemas with a known display-name field (alerting profile, MZ, auto-tag rule, etc.); other schemas are skipped silently."
          ),
        acknowledgeDuplicate: z
          .boolean()
          .optional()
          .describe(
            "Required if a payload with the same fingerprint was submitted in the last 10 minutes (typical when retrying after a timeout). Pass true to override the duplicate warning."
          ),
        confirm: z
          .literal("yes")
          .describe(
            "Must be the literal string 'yes'. Guards against accidental LLM-initiated writes."
          ),
      },
    },
    async ({ objects, skipPreValidate, skipExistsCheck, acknowledgeDuplicate, confirm }) => {
      if (confirm !== "yes") return refuse("confirm must be 'yes'");

      const body = objects.map((o) => ({
        schemaId: o.schemaId,
        scope: o.scope,
        value: o.value,
      }));

      // ---------- pre-validate (default on) ----------
      if (!skipPreValidate) {
        const pre = await preValidateSettings(client, TOOL, body);
        if (!pre.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: "/api/v2/settings/objects (pre-validate refused)",
            validateOnly: true,
            status: "error",
            requestBody: { invalidItems: pre.invalidItems },
            error: "pre-validate refused",
          });
          return pre.refusal;
        }
      }

      // ---------- already-exists (default on) ----------
      if (!skipExistsCheck) {
        const exists = await checkAlreadyExists(client, TOOL, body);
        if (!exists.ok) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: "/api/v2/settings/objects (already-exists refused)",
            validateOnly: true,
            status: "error",
            requestBody: { conflicts: exists.conflicts },
            error: "already-exists refused",
          });
          return exists.refusal;
        }
      }

      // ---------- payload fingerprint / dedup ----------
      const dup = checkDuplicatePayload(audit, TOOL, body);
      if (dup.isDuplicate && !acknowledgeDuplicate) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: false,
                  refused: true,
                  reason: dup.warning,
                  fingerprint: dup.fingerprint,
                  priorRecordTimestamp: dup.priorRecord?.timestamp,
                  priorRecordStatus: dup.priorRecord?.status,
                  note: "Pass acknowledgeDuplicate:true to proceed anyway (e.g. if this is an intentional clone).",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // ---------- real create ----------
      try {
        const { status, path, data } = await client.post<unknown>(
          TOOL,
          "/api/v2/settings/objects",
          body
        );
        audit.write({
          timestamp: new Date().toISOString(),
          tool: TOOL,
          method: "POST",
          path,
          validateOnly: false,
          status,
          requestBody: body,
          responseBody: data,
          payloadFingerprint: dup.fingerprint,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: true,
                  status,
                  preValidated: !skipPreValidate,
                  existsChecked: !skipExistsCheck,
                  payloadFingerprint: dup.fingerprint,
                  response: data,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof WriteNotEnabledError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        if (err instanceof DtApiError) {
          audit.write({
            timestamp: new Date().toISOString(),
            tool: TOOL,
            method: "POST",
            path: err.path,
            validateOnly: false,
            status: err.status,
            requestBody: body,
            error: err.body,
            payloadFingerprint: dup.fingerprint,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    created: false,
                    preValidated: !skipPreValidate,
                    status: err.status,
                    error: err.body,
                    note: skipPreValidate
                      ? "skipPreValidate was true — Dynatrace's error above is the only validation signal."
                      : "Pre-validate passed but the real create still failed. Often means cluster state changed between validate and create (e.g. another caller created a conflicting object).",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
  );
}
