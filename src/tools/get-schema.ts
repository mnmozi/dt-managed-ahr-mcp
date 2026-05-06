import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface SchemaProperty {
  type?: string;
  description?: string;
  documentation?: string;
  default?: unknown;
  nullable?: boolean;
  items?: SchemaProperty;
  referencedType?: string;
  enums?: Array<{ value: unknown; displayName?: string; description?: string }>;
  constraints?: unknown[];
  minObjects?: number;
  maxObjects?: number;
  [k: string]: unknown;
}

interface SchemaDefinition {
  schemaId?: string;
  displayName?: string;
  description?: string;
  documentation?: string;
  schemaVersion?: string;
  multiObject?: boolean;
  properties?: Record<string, SchemaProperty>;
  enums?: Record<string, unknown>;
  types?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Recursively walks a schema property tree and extracts a compact summary
 * focused on what an LLM needs to construct a valid payload:
 *  - field path
 *  - type
 *  - enum values (if any)
 *  - required / nullable flags
 *  - one-line description
 */
function summarizeProperty(
  name: string,
  prop: SchemaProperty,
  enums: Record<string, unknown> | undefined,
  types: Record<string, unknown> | undefined,
  pathPrefix = ""
): unknown[] {
  const path = pathPrefix ? `${pathPrefix}.${name}` : name;
  const out: unknown[] = [];

  const enumValues =
    prop.enums?.map((e) => e.value) ??
    (typeof prop.type === "string" && enums && enums[prop.type]
      ? extractEnumValues(enums[prop.type])
      : undefined);

  out.push({
    path,
    type: prop.type ?? "object",
    nullable: prop.nullable ?? false,
    description: (prop.description ?? prop.documentation ?? "").trim().slice(0, 200) || undefined,
    default: prop.default,
    enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
    referencedType: prop.referencedType,
    minObjects: prop.minObjects,
    maxObjects: prop.maxObjects,
  });

  // Walk into a referenced object/list type
  const refTypeName = prop.referencedType ?? (prop.type === "list" ? prop.items?.referencedType : undefined);
  if (refTypeName && types && types[refTypeName]) {
    const refType = types[refTypeName] as { properties?: Record<string, SchemaProperty> };
    if (refType.properties) {
      for (const [childName, childProp] of Object.entries(refType.properties)) {
        out.push(...summarizeProperty(childName, childProp, enums, types, path));
      }
    }
  }

  // Walk into inline list item structure
  if (prop.type === "list" && prop.items?.properties) {
    for (const [childName, childProp] of Object.entries(
      prop.items.properties as Record<string, SchemaProperty>
    )) {
      out.push(...summarizeProperty(childName, childProp, enums, types, `${path}[]`));
    }
  }

  return out;
}

function extractEnumValues(enumDef: unknown): unknown[] {
  if (!enumDef || typeof enumDef !== "object") return [];
  const items = (enumDef as { items?: Array<{ value: unknown }> }).items;
  return items ? items.map((i) => i.value) : [];
}

export function registerGetSchema(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_schema",
    {
      description:
        "Fetch the full Settings 2.0 schema definition for a given schemaId. Returns the structure (fields, types, enums, constraints, defaults) that you need to construct a valid payload for dt_create_settings / dt_update_settings (in dt-write-mcp). Use mode='full' for the raw schema or mode='summary' for a flattened LLM-friendly field list.",
      inputSchema: {
        schemaId: z
          .string()
          .min(1)
          .describe("e.g. 'builtin:tags.auto-tagging' or 'builtin:management-zones'."),
        version: z
          .string()
          .optional()
          .describe("Optional specific schema version (e.g. '1.0.18'). Omit for the latest."),
        mode: z
          .enum(["full", "summary"])
          .optional()
          .describe("'full' returns the raw schema (large). 'summary' (default) returns a flat list of fields with type + enum values + descriptions."),
      },
    },
    async ({ schemaId, version, mode }) => {
      const path = version
        ? `/api/v2/settings/schemas/${encodeURIComponent(schemaId)}/${encodeURIComponent(version)}`
        : `/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`;
      const schema = await client.get<SchemaDefinition>(path);

      const effectiveMode = mode ?? "summary";
      if (effectiveMode === "full") {
        return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
      }

      const fields: unknown[] = [];
      if (schema.properties) {
        for (const [name, prop] of Object.entries(schema.properties)) {
          fields.push(...summarizeProperty(name, prop, schema.enums, schema.types));
        }
      }

      const summary = {
        schemaId: schema.schemaId,
        displayName: schema.displayName,
        schemaVersion: schema.schemaVersion,
        multiObject: schema.multiObject,
        description: (schema.description ?? schema.documentation ?? "").trim() || undefined,
        fieldCount: fields.length,
        fields,
        topLevelEnums: schema.enums ? Object.keys(schema.enums) : [],
        topLevelTypes: schema.types ? Object.keys(schema.types) : [],
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );
}
