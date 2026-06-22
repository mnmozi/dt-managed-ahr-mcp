/**
 * Shared shape for what we return from every tool handler.
 *
 * The MCP SDK's `CallToolResult` type carries an index signature
 * (`[x: string]: unknown`) — we include it here so structural typing
 * matches and the handler's return value is assignable without casts.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Convenience builder for the common "single text payload" result. */
export function textResult(payload: unknown, isError = false): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** Common refusal helper. */
export function refuse(reason: string): ToolResult {
  return { content: [{ type: "text", text: `refused: ${reason}` }], isError: true };
}
