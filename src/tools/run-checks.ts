import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DtClient } from "../dt-client.js";
import { getEngine } from "../engine/engine-singleton.js";
import { buildBundle, CHECK_REQUIREMENTS } from "../engine/bundle-builder.js";

/**
 * MCP-to-MCP integration: the data MCP knows which engine function to call.
 *
 * Flow:
 *   1. dt_list_checks → ask the engine MCP what checks exist
 *   2. dt_run_checks → materialize bundle from live reads, call engine, return findings
 *
 * The engine MCP is spawned lazily as a child process when first needed and
 * kept alive for the session. The binary is resolved via DT_ENGINE_BIN env
 * var (with fallback to PATH lookup of `dt-engine`).
 *
 * Bundle directory: defaults to <DT_BUNDLE_DIR>/<timestamp>/ if DT_BUNDLE_DIR
 * is set, else <cwd>/.bundles/<timestamp>/. Persistent so the engine can be
 * re-run against the same bundle without re-collecting.
 */

function bundleRootForToday(): string {
  const base = process.env.DT_BUNDLE_DIR?.trim() || join(process.cwd(), ".bundles");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(base, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerListChecks(server: McpServer): void {
  server.registerTool(
    "dt_list_checks",
    {
      description:
        "List every deterministic check the engine can run. Returns { id, phase } per check. Use this to discover what's available BEFORE calling dt_run_checks. Spawns the engine subprocess on first call.",
      inputSchema: {},
    },
    async () => {
      try {
        const engine = await getEngine();
        const checks = await engine.listChecks();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: checks.length, checks }, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  available: false,
                  error: msg,
                  hint: "Set DT_ENGINE_BIN to the path of the dt-engine binary, or ensure it's on PATH. Build via `cd ../dt-managed-engine && go build -o dt-engine ./cmd/dt-engine`.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export function registerRunChecks(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_run_checks",
    {
      description:
        "Run deterministic checks against this tenant. Steps: (1) materializes a bundle by fetching the required raw files from Dynatrace, (2) hands off to the engine MCP for evaluation, (3) returns the engine's findings. Pass checks=[] to run every registered check; pass specific IDs (e.g. ['CHECK_AUTO_TAG_DEAD']) to run a subset. Use existingBundlePath to skip materialization and re-run against a previously-built bundle.",
      inputSchema: {
        checks: z
          .array(z.string())
          .optional()
          .describe(
            "Filter to specific check IDs. Empty / omitted = run all. Use dt_list_checks to discover available IDs."
          ),
        phases: z
          .array(z.string())
          .optional()
          .describe(
            "Optional phase filter applied AFTER checks[], e.g. ['Phase 1','Phase 3']."
          ),
        existingBundlePath: z
          .string()
          .optional()
          .describe(
            "If set, skip bundle materialization and run the engine against this existing bundle path. Useful for re-running checks without re-fetching from Dynatrace."
          ),
        skipExisting: z
          .boolean()
          .optional()
          .describe(
            "When materializing, skip files that already exist on disk. Default true. Set false to force re-fetch."
          ),
      },
    },
    async ({ checks, phases, existingBundlePath, skipExisting }) => {
      try {
        const engine = await getEngine();

        // ---------- step 1: bundle materialization (or reuse) ----------
        let bundleResult: {
          bundlePath: string;
          fetchedFiles: string[];
          failedFiles: Array<{ name: string; error: string }>;
          skippedFiles: string[];
        };
        if (existingBundlePath) {
          bundleResult = {
            bundlePath: existingBundlePath,
            fetchedFiles: [],
            failedFiles: [],
            skippedFiles: [],
          };
        } else {
          const requested = checks ?? [];
          // Warn about unknown check IDs early — better than the engine
          // silently dropping them.
          const unknown = requested.filter((id) => !(id in CHECK_REQUIREMENTS));
          if (unknown.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ran: false,
                      reason: `unknown check ID(s): ${unknown.join(", ")} — bundle-builder doesn't know what files they need. Call dt_list_checks to see valid IDs, or set existingBundlePath if you've already materialized a bundle.`,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
          const bundleRoot = bundleRootForToday();
          bundleResult = await buildBundle(
            client,
            bundleRoot,
            requested,
            skipExisting !== false
          );
        }

        // ---------- step 2: hand off to engine MCP ----------
        const engineResult = await engine.run({
          bundlePath: bundleResult.bundlePath,
          checks: checks && checks.length > 0 ? checks : undefined,
          phases: phases && phases.length > 0 ? phases : undefined,
        });

        // ---------- step 3: shape result ----------
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  bundle: {
                    path: bundleResult.bundlePath,
                    fetched: bundleResult.fetchedFiles.length,
                    failed: bundleResult.failedFiles,
                    skipped: bundleResult.skippedFiles.length,
                    reused: Boolean(existingBundlePath),
                  },
                  engine: engineResult.engine,
                  counts: engineResult.counts,
                  findings: engineResult.findings ?? [],
                  note: engineResult.note,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ran: false,
                  error: msg,
                  hint:
                    "If this is the first call, the engine subprocess may have failed to start. Set DT_ENGINE_BIN to the path of dt-engine, or ensure it's on PATH.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
