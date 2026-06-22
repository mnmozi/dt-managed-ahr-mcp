import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Readable } from "node:stream";
import { makeLogger, type Logger } from "../logger.js";

/**
 * EngineClient — MCP client to the dt-engine MCP server.
 *
 * On `start()` we spawn `dt-engine mcp` as a child process and connect over
 * stdio. The engine exposes:
 *   - engine_list_checks / engine_run / engine_run_checks
 *   - engine_list_analyzers / engine_analyze
 *
 * Connection is lazy + persistent for the MCP session. We don't reconnect on
 * each call; if the child dies the next call surfaces an error.
 *
 * STDERR PIPING: the engine writes log lines to its stderr. We attach a
 * line-buffered reader that forwards each line to the MCP's structured logger
 * with source: "engine". If the line is JSON, we parse it and re-emit at the
 * matching level; otherwise we forward as plain text at info level.
 *
 * BINARY: DT_ENGINE_BIN env var if set, else `dt-engine` on PATH.
 */
export class EngineClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly log: Logger;

  constructor(private readonly binPath: string) {
    this.log = makeLogger("engine-client");
  }

  /** Spawn the engine + handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.client) return;
    this.log.info("spawning engine subprocess", { binPath: this.binPath });
    this.transport = new StdioClientTransport({
      command: this.binPath,
      args: ["mcp"],
      stderr: "pipe",
    });
    this.client = new Client(
      { name: "dt-managed-mcp", version: "0.1.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
    this.log.info("engine subprocess connected");
    this.attachStderrForwarder();
  }

  /**
   * Wire the engine subprocess's stderr stream into our logger. We do this
   * AFTER connect() so the SDK has finished setting up the transport and
   * exposed the stderr handle. Tolerant: if no stderr is available, we just
   * note it and proceed (the engine still works, we just lose its logs).
   */
  private attachStderrForwarder(): void {
    const stderr = this.transport?.stderr as Readable | null | undefined;
    if (!stderr) {
      this.log.warn("engine stderr not attached — logs from the engine will not appear");
      return;
    }
    const engineLog = makeLogger("engine");
    let buffer = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        forwardEngineLine(engineLog, line);
      }
    });
    stderr.on("close", () => {
      if (buffer.length > 0) {
        forwardEngineLine(engineLog, buffer.trimEnd());
        buffer = "";
      }
      engineLog.info("engine stderr stream closed");
    });
    stderr.on("error", (err) => {
      engineLog.error("engine stderr stream error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Call a tool on the engine and return the raw text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("engine client not started — call start() first");
    const start = Date.now();
    this.log.debug("engine tool call", { tool: name });
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const elapsedMs = Date.now() - start;
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
      this.log.debug("engine tool ok", { tool: name, elapsedMs, bytes: texts.join("").length });
      return texts.join("\n");
    } catch (err) {
      const elapsedMs = Date.now() - start;
      this.log.error("engine tool failed", {
        tool: name,
        elapsedMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Convenience: parse engine_list_checks response. */
  async listChecks(): Promise<Array<{ id: string; phase: string }>> {
    const text = await this.callTool("engine_list_checks", {});
    const parsed = JSON.parse(text) as { checks?: Array<{ id: string; phase: string }> };
    return parsed.checks ?? [];
  }

  /** Convenience: call engine_run with optional filters and return the parsed Result. */
  async run(args: {
    bundlePath: string;
    checks?: string[];
    phases?: string[];
  }): Promise<EngineRunResult> {
    const text = await this.callTool("engine_run", args);
    return JSON.parse(text) as EngineRunResult;
  }

  /**
   * Call an analyzer by kind. Returns the parsed analyzer output.
   * Generic on T so callers get typed results when they know the shape.
   */
  async analyze<T = unknown>(kind: string, input: unknown): Promise<T> {
    const text = await this.callTool("engine_analyze", { kind, input });
    return JSON.parse(text) as T;
  }

  /** List analyzers available on the engine. */
  async listAnalyzers(): Promise<Array<{ kind: string; description: string }>> {
    const text = await this.callTool("engine_list_analyzers", {});
    const parsed = JSON.parse(text) as {
      analyzers?: Array<{ kind: string; description: string }>;
    };
    return parsed.analyzers ?? [];
  }

  async stop(): Promise<void> {
    this.log.info("stopping engine subprocess");
    try {
      await this.client?.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.transport?.close();
    } catch {
      // ignore close errors
    }
    this.client = null;
    this.transport = null;
  }
}

/**
 * Forward a single line of engine stderr to our logger. Try JSON first
 * (matches Go's slog JSON handler shape: `{"time":"...","level":"INFO","msg":"...",...}`),
 * fall back to plain text at info level.
 *
 * Slog's level field is uppercase ("INFO", "WARN", ...); we map to our
 * lowercase scheme. Slog's timestamp field is "time"; our outer logger adds
 * its own "ts" anyway so we discard the engine's time field.
 */
function forwardEngineLine(log: Logger, line: string): void {
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const rawLevel = String(obj.level ?? "").toLowerCase();
      const msg = String(obj.msg ?? obj.message ?? line);
      // Strip outer-logger keys so we don't double-emit / collide.
      // The engine's `source` field is moved to `engineSource` so we
      // preserve the engine's internal source without clobbering our
      // outer `source: "engine"`.
      const { time: _t, level: _l, msg: _m, message: _msg2, source: engineSource, ...rest } = obj;
      void _t;
      void _l;
      void _m;
      void _msg2;
      const fields: Record<string, unknown> = { ...rest };
      if (engineSource !== undefined) fields.engineSource = engineSource;
      switch (rawLevel) {
        case "debug":
          log.debug(msg, fields);
          return;
        case "warn":
        case "warning":
          log.warn(msg, fields);
          return;
        case "error":
        case "err":
          log.error(msg, fields);
          return;
        case "info":
          log.info(msg, fields);
          return;
        case "trace":
          log.trace(msg, fields);
          return;
        default:
          log.info(msg, fields);
          return;
      }
    } catch {
      // fall through to text path
    }
  }
  log.info(line);
}

/** Result shape the engine MCP returns (mirrors runner.Result on the Go side). */
export interface EngineRunResult {
  bundle_root: string;
  engine: { version: string; checks_applied: number };
  counts: { total: number; high: number; medium: number; low: number; info: number };
  findings: EngineFinding[] | null;
  note?: string;
}

export interface EngineFinding {
  id: string;
  phase: string;
  severity: "High" | "Medium" | "Low" | "Info";
  title: string;
  description?: string;
  evidence: { tool: string; raw_path: string; data_point: string };
  recommendation: string;
  entity_ref?: { kind: string; id: string; name?: string };
  fix_template?: {
    write_action: string;
    schema_id?: string;
    object_id?: string;
    hint?: string;
    value_hints?: Record<string, unknown>;
  };
}
