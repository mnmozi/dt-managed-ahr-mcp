import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DtClient } from "../dt-client.js";
import { registerClusterReads } from "../tools/cluster-reads.js";

/**
 * Cluster Management API reads. Always registered: without a cluster token
 * each tool answers available:false with the env var to set, so an AHR run
 * can tell "not configured" from "not implemented".
 */
export function registerClusterReadTools(server: McpServer, client: DtClient): void {
  registerClusterReads(server, client);
}
