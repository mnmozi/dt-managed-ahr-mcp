import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DtClient } from "../dt-client.js";

interface ExtensionItem {
  extensionName?: string;
  version?: string;
  type?: string;
  authorName?: string;
  [k: string]: unknown;
}

interface ExtensionListResp {
  totalCount?: number;
  nextPageKey?: string | null;
  extensions?: ExtensionItem[];
}

export function registerExtensions(server: McpServer, client: DtClient): void {
  server.registerTool(
    "dt_get_extensions",
    {
      description:
        "List installed Extensions 2.0 with name, version, type, author. Returns full list + a summary (count by type, count by author, count of unique extensions, version map).",
      inputSchema: {
        nameFilter: z
          .string()
          .optional()
          .describe("Optional case-insensitive substring to filter the extension name."),
      },
    },
    async ({ nameFilter }) => {
      const all: ExtensionItem[] = [];
      let nextPageKey: string | null | undefined;
      let pages = 0;
      do {
        const resp = nextPageKey
          ? await client.get<ExtensionListResp>("/api/v2/extensions", {
              query: { nextPageKey },
            })
          : await client.get<ExtensionListResp>("/api/v2/extensions", {
              query: { pageSize: 500 },
            });
        if (resp.extensions) all.push(...resp.extensions);
        nextPageKey = resp.nextPageKey ?? null;
        pages++;
      } while (nextPageKey && pages < 100);

      let filtered = all;
      if (nameFilter) {
        const n = nameFilter.toLowerCase();
        filtered = all.filter((e) => (e.extensionName ?? "").toLowerCase().includes(n));
      }

      const byType = new Map<string, number>();
      const byAuthor = new Map<string, number>();
      const versions = new Map<string, Set<string>>();
      for (const e of filtered) {
        byType.set(e.type ?? "UNKNOWN", (byType.get(e.type ?? "UNKNOWN") ?? 0) + 1);
        byAuthor.set(e.authorName ?? "UNKNOWN", (byAuthor.get(e.authorName ?? "UNKNOWN") ?? 0) + 1);
        const name = e.extensionName ?? "UNKNOWN";
        if (!versions.has(name)) versions.set(name, new Set());
        if (e.version) versions.get(name)!.add(e.version);
      }
      const multiVersion = [...versions.entries()]
        .filter(([, vs]) => vs.size > 1)
        .map(([name, vs]) => ({ name, versions: [...vs] }));

      const summary = {
        totalReturned: filtered.length,
        uniqueExtensions: versions.size,
        byType: Object.fromEntries(byType),
        byAuthor: Object.fromEntries(byAuthor),
        extensionsWithMultipleVersions: multiVersion,
      };

      return {
        content: [
          { type: "text", text: JSON.stringify({ summary, extensions: filtered }, null, 2) },
        ],
      };
    }
  );
}
