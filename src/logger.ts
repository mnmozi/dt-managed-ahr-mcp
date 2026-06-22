/**
 * Structured logger for the MCP.
 *
 * Output: JSONL to stderr. Stdout is reserved for the MCP transport
 * (JSON-RPC) — never log there or we corrupt the protocol.
 *
 * Optional mirror: set DT_LOG_FILE to an absolute path and every log line
 * is also appended to that file (in addition to stderr). Useful when the
 * MCP runs as a subprocess of Claude Code / another agent runtime that
 * only captures the initial stderr burst — `tail -f` the file to watch
 * activity in real time.
 *
 * Optional engine-log split: set DT_ENGINE_LOG_FILE to an absolute path
 * and lines with `source: "engine"` (the ones forwarded from the Go
 * subprocess via engine-client.ts) go ONLY to that file. Everything else
 * still goes to DT_LOG_FILE. Convenient when evaluating the Go analyzers
 * — tail the engine file alone to see analyzer activity without the
 * surrounding MCP HTTP / lifecycle noise. Without this env var, engine
 * lines flow into DT_LOG_FILE alongside everything else.
 *
 * Files open append-mode at first use; rotation is the caller's
 * responsibility (logrotate, etc.).
 *
 * Filter via DT_LOG_LEVEL env var: trace | debug | info | warn | error.
 * Default: info.
 *
 * Each line looks like:
 *   {"ts":"2026-05-17T12:34:56.789Z","level":"warn","source":"http","msg":"retrying","attempt":2,"status":429,"path":"/api/v2/entities"}
 *
 * The shape is stable — consumers (operators / log aggregators) can parse
 * these reliably. New fields can be added freely; existing fields don't
 * rename or change type.
 */

import { createWriteStream, type WriteStream } from "node:fs";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function resolveLevel(): LogLevel {
  const v = (process.env.DT_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (v in LEVEL_ORDER) return v as LogLevel;
  return "info";
}

let currentLevel: LogLevel = resolveLevel();

/** Override the active log level at runtime. Primarily for tests. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Optional file mirrors. Opened lazily on first log call so importing
 * this module is side-effect-free for tests. We do NOT throw if a file
 * can't be opened — a broken env var shouldn't take down the MCP.
 * Failure is logged once to stderr; subsequent log calls just skip the
 * file write.
 *
 * Two streams kept independent:
 *   mainStream   ← DT_LOG_FILE       (everything except engine lines IF engine file is set)
 *   engineStream ← DT_ENGINE_LOG_FILE (only the engine-sourced lines)
 *
 * `undefined` means "haven't tried yet"; `null` means "tried and failed
 * (or env not set), skip".
 */
let mainStream: WriteStream | null | undefined;
let engineStream: WriteStream | null | undefined;

function openStream(envVar: "DT_LOG_FILE" | "DT_ENGINE_LOG_FILE"): WriteStream | null {
  const path = process.env[envVar]?.trim();
  if (!path) return null;
  try {
    const s = createWriteStream(path, { flags: "a", encoding: "utf8" });
    s.on("error", (err) => {
      process.stderr.write(
        `${new Date().toISOString()} ERROR [logger] ${envVar} write failed: ${err.message}\n`
      );
    });
    process.stderr.write(
      `${new Date().toISOString()} INFO [logger] mirroring ${envVar === "DT_ENGINE_LOG_FILE" ? "engine " : ""}logs to ${path}\n`
    );
    return s;
  } catch (err) {
    process.stderr.write(
      `${new Date().toISOString()} ERROR [logger] could not open ${envVar}='${path}': ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

function getMainStream(): WriteStream | null {
  if (mainStream !== undefined) return mainStream;
  mainStream = openStream("DT_LOG_FILE");
  return mainStream;
}

function getEngineStream(): WriteStream | null {
  if (engineStream !== undefined) return engineStream;
  engineStream = openStream("DT_ENGINE_LOG_FILE");
  return engineStream;
}

/** Fields you can attach to a log entry. Arbitrary JSON-safe values. */
export type LogFields = Record<string, unknown>;

interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  source: string;
  msg: string;
}

function emit(level: LogLevel, source: string, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const rec: LogRecord = {
    ts: new Date().toISOString(),
    level,
    source,
    msg,
    ...(fields ?? {}),
  };
  // Manual JSON to keep output strictly one line per record.
  let line: string;
  try {
    line = JSON.stringify(rec) + "\n";
  } catch {
    // If JSON serialization fails (circular ref, etc.) fall back to text.
    line = `${rec.ts} ${level.toUpperCase()} [${source}] ${msg} <unserializable fields>\n`;
  }
  process.stderr.write(line);

  // File routing:
  //   engine line + engine file set → engine file ONLY (keeps it focused)
  //   engine line + no engine file  → main file
  //   non-engine line               → main file
  const isEngine = source === "engine";
  if (isEngine) {
    const es = getEngineStream();
    if (es) {
      es.write(line);
      return;
    }
  }
  const ms = getMainStream();
  if (ms) ms.write(line);
}

/**
 * Logger bound to a source. Returned by makeLogger().
 *
 * Methods are level-named. Each takes a message and optional structured
 * fields. Fields override defaults: passing { ts: "..." } in fields will
 * NOT override the auto-timestamp — fields are spread BEFORE the core
 * fields are set on the way out (we control field order by using a fresh
 * object every call).
 */
export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Create a child logger with permanent fields automatically attached. */
  child(staticFields: LogFields): Logger;
}

/**
 * makeLogger creates a Logger bound to a source name.
 * Source convention: short lowercase identifier (e.g. "http", "engine",
 * "lifecycle"). Sub-components add child fields rather than nested sources.
 */
export function makeLogger(source: string, staticFields?: LogFields): Logger {
  const merge = (extra?: LogFields): LogFields | undefined => {
    if (!staticFields && !extra) return undefined;
    if (!staticFields) return extra;
    if (!extra) return staticFields;
    return { ...staticFields, ...extra };
  };
  return {
    trace: (msg, fields) => emit("trace", source, msg, merge(fields)),
    debug: (msg, fields) => emit("debug", source, msg, merge(fields)),
    info: (msg, fields) => emit("info", source, msg, merge(fields)),
    warn: (msg, fields) => emit("warn", source, msg, merge(fields)),
    error: (msg, fields) => emit("error", source, msg, merge(fields)),
    child: (extra) => makeLogger(source, merge(extra)),
  };
}

/** Module-level logger for code that doesn't have a specific source yet. */
export const rootLogger: Logger = makeLogger("dt-mcp");
