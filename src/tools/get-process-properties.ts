import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface EntityResponse {
  entityId?: string;
  displayName?: string;
  type?: string;
  properties?: Record<string, unknown>;
  tags?: Array<{ context?: string; key?: string; value?: string; stringRepresentation?: string }>;
  managementZones?: Array<{ id?: string; name?: string }>;
  fromRelationships?: Record<string, unknown>;
  toRelationships?: Record<string, unknown>;
  [k: string]: unknown;
}

interface RulableProperty {
  path: string;
  value: unknown;
  /** "stable" | "moderate" | "fragile" — guidance for rule authors. */
  stability: "stable" | "moderate" | "fragile";
  rationale: string;
  /**
   * Suggested matching mechanism if the user wants to write a rule against this property.
   * Names are descriptive — actual schema fields differ between auto-tag and PG-detection schemas.
   */
  ruleHint: string;
}

/**
 * Walks an entity's properties and produces a "what-you-can-rule-on" view.
 * Categorizes properties by stability so an LLM proposing a rule can pick the
 * stable signal (env vars, host group) over the fragile one (cmdline args, PIDs).
 */
function classifyProperties(properties: Record<string, unknown>): {
  categorized: Record<string, unknown>;
  rulable: RulableProperty[];
} {
  const categorized: Record<string, unknown> = {
    executable: {},
    listenPorts: undefined,
    commandLine: undefined,
    envVars: {},
    jvm: {},
    kubernetes: {},
    aws: {},
    azure: {},
    cloudFoundry: {},
    softwareTechnologies: undefined,
    other: {},
  };
  const rulable: RulableProperty[] = [];

  for (const [key, value] of Object.entries(properties)) {
    const lk = key.toLowerCase();

    // Executable
    if (lk === "executablepath") {
      (categorized.executable as Record<string, unknown>).path = value;
      rulable.push({
        path: `executable.path`,
        value,
        stability: "stable",
        rationale:
          "Executable path is fixed for a given binary version; only changes on package upgrade.",
        ruleHint: "PG detection: executablePath equals/startsWith. Auto-tag: same.",
      });
      continue;
    }
    if (lk === "executablename") {
      (categorized.executable as Record<string, unknown>).name = value;
      rulable.push({
        path: `executable.name`,
        value,
        stability: "stable",
        rationale: "Executable name is stable but coarse — many processes share names like 'java'.",
        ruleHint: "Useful only when combined with another condition.",
      });
      continue;
    }

    // Listening ports
    if (lk === "listenports" || lk === "listenport") {
      categorized.listenPorts = value;
      rulable.push({
        path: `listenPorts`,
        value,
        stability: "moderate",
        rationale:
          "Ports change when ops re-bind; stable for well-known services, fragile for ephemeral ones.",
        ruleHint: "PG detection rule: process listens on port N.",
      });
      continue;
    }

    // Command line
    if (lk === "commandline" || lk === "commandlineargs" || lk === "commandlineargument") {
      categorized.commandLine = value;
      rulable.push({
        path: `commandLine`,
        value,
        stability: "fragile",
        rationale:
          "Cmdline shifts between deploys (paths, hashes, generated args). Avoid as a primary rule signal.",
        ruleHint: "Use only as a last resort, with a substring match anchored on a stable token.",
      });
      continue;
    }

    // Env vars — multiple shapes across DT versions
    if (lk.includes("envvar") || lk.includes("metadata")) {
      // value could be: { items: [{key, value}] } | { K: V } | string
      const flattened = flattenEnvVars(value);
      Object.assign(categorized.envVars as Record<string, unknown>, flattened);
      for (const [k, v] of Object.entries(flattened)) {
        rulable.push({
          path: `envVars.${k}`,
          value: v,
          stability: "stable",
          rationale: k.startsWith("DT_")
            ? "DT_* env vars are first-class signals Dynatrace explicitly recognizes (DT_TAGS, DT_CLUSTER_ID, DT_NODE_ID)."
            : "Env vars are set at deploy time and persist for the process lifetime — strong signal.",
          ruleHint:
            "Auto-tag or PG-detection: condition on environment variable. Or set DT_TAGS=key:value to push a tag from the process itself.",
        });
      }
      continue;
    }

    // JVM
    if (lk.includes("jvm") || lk.includes("java")) {
      (categorized.jvm as Record<string, unknown>)[key] = value;
      continue;
    }

    // Kubernetes
    if (lk.includes("kubernetes") || lk.includes("k8s") || lk.includes("pod") || lk.includes("namespace")) {
      (categorized.kubernetes as Record<string, unknown>)[key] = value;
      rulable.push({
        path: `kubernetes.${key}`,
        value,
        stability: "stable",
        rationale: "K8s metadata is set by the orchestrator and authoritative.",
        ruleHint: "Auto-tag rule: condition on Kubernetes namespace / label / annotation.",
      });
      continue;
    }

    // Cloud
    if (lk.startsWith("aws") || lk.includes("ec2")) {
      (categorized.aws as Record<string, unknown>)[key] = value;
      continue;
    }
    if (lk.startsWith("azure")) {
      (categorized.azure as Record<string, unknown>)[key] = value;
      continue;
    }
    if (lk.includes("cloudfoundry") || lk.includes("cf_")) {
      (categorized.cloudFoundry as Record<string, unknown>)[key] = value;
      continue;
    }

    // Software stack
    if (lk === "softwaretechnologies") {
      categorized.softwareTechnologies = value;
      continue;
    }

    (categorized.other as Record<string, unknown>)[key] = value;
  }

  // Strip empty categories for tidiness
  for (const [k, v] of Object.entries(categorized)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
      delete categorized[k];
    }
    if (v === undefined) delete categorized[k];
  }

  return { categorized, rulable };
}

function flattenEnvVars(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  // Shape A: { items: [{ key, value }] }
  if (typeof value === "object" && value !== null && "items" in value) {
    const items = (value as { items?: Array<{ key?: string; value?: unknown }> }).items;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it.key) out[it.key] = String(it.value ?? "");
      }
      return out;
    }
  }
  // Shape B: { KEY: "value", ... }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  }
  // Shape C: stringified
  if (typeof value === "string") {
    // try parse as KEY=val newline-separated
    for (const line of value.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return out;
}

export function registerGetProcessProperties(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_process_properties",
    {
      description:
        "Fetch all properties of a PROCESS_GROUP, PROCESS_GROUP_INSTANCE, or HOST entity and return a categorized 'what-you-can-rule-on' view: env vars (split out), JVM args, exe path/name, listening ports, command line, k8s/AWS/Azure/CF metadata, software stack, plus a 'rulableProperties' list with a stability rating per property. Use this BEFORE proposing an auto-tag or PG-detection rule so you pick a stable signal (env var, host group) over a fragile one (cmdline).",
      inputSchema: {
        entityId: z
          .string()
          .min(1)
          .describe(
            "Entity id, e.g. 'PROCESS_GROUP_INSTANCE-1234ABCD' or 'PROCESS_GROUP-...' or 'HOST-...'"
          ),
        rawOnly: z
          .boolean()
          .optional()
          .describe(
            "If true, return only the raw entity payload without categorization. Default: false."
          ),
      },
    },
    async ({ entityId, rawOnly }) => {
      const path = `/api/v2/entities/${encodeURIComponent(entityId)}`;
      const data = await client.get<EntityResponse>(path, {
        query: {
          fields: "+properties,+managementZones,+tags,+fromRelationships,+toRelationships",
        },
      });

      if (rawOnly) {
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      const { categorized, rulable } = classifyProperties(data.properties ?? {});
      const result = {
        entityId: data.entityId,
        type: data.type,
        displayName: data.displayName,
        tags: data.tags,
        managementZones: data.managementZones,
        categorized,
        rulableProperties: rulable.sort((a, b) => {
          const order = { stable: 0, moderate: 1, fragile: 2 } as const;
          return order[a.stability] - order[b.stability];
        }),
        relationships: {
          from: Object.keys(data.fromRelationships ?? {}),
          to: Object.keys(data.toRelationships ?? {}),
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
