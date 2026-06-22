import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";
import type { DtConfig } from "../config.js";

import { registerListSchemas } from "../tools/list-schemas.js";
import { registerGetSchema } from "../tools/get-schema.js";
import { registerListSettingsObjects } from "../tools/list-settings-objects.js";
import { registerGetSettingsObject } from "../tools/get-settings-object.js";
import { registerRawGet } from "../tools/raw-get.js";
import { registerListTagsForEntity } from "../tools/entity-tags.js";
import { registerGetProcessProperties } from "../tools/get-process-properties.js";
import { registerConditionalNaming } from "../tools/conditional-naming.js";
import { registerWhoami } from "../tools/whoami.js";

/** Core read tools: Settings 2.0 generics, raw-get, entity-tags, naming, whoami. */
export function registerCoreReads(server: McpServer, client: DtClient, cfg: DtConfig): void {
  registerListSchemas(server, client);
  registerGetSchema(server, client);
  registerListSettingsObjects(server, client);
  registerGetSettingsObject(server, client);
  registerRawGet(server, client);
  registerListTagsForEntity(server, client);
  registerGetProcessProperties(server, client);
  registerConditionalNaming(server, client);
  registerWhoami(server, cfg);
}
