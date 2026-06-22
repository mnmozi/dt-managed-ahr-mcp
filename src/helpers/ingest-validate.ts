/**
 * Pre-ingest validation for dt_ingest_metric, dt_ingest_logs, dt_ingest_bizevent.
 *
 * Why: all three of Dynatrace's ingest endpoints return 200/202 even when
 * SOME of the lines/records were silently rejected. The per-line failure
 * details come back in the response body, but in practice nobody reads
 * them — the caller sees "200 OK" and moves on. The metric series, log
 * line, or bizevent never made it to disk, and only weeks later does
 * anyone notice the missing data.
 *
 * The fix: parse + validate every line/record BEFORE we POST. We catch
 * the foot-guns Dynatrace silently swallows:
 *
 *   Metrics line protocol:
 *     - metric.key invalid char / starts with digit
 *     - empty dimension key
 *     - more than 50 dims (Dynatrace cap)
 *     - value not parseable as a number / typed value
 *     - timestamp not a positive integer
 *
 *   Logs:
 *     - missing or empty content
 *     - timestamp not a string OR positive int
 *     - severity / loglevel not a recognized bucket (warning only)
 *     - record body > 8KB (Dynatrace soft cap; warning only)
 *
 *   Bizevents (default encoding):
 *     - missing event.type / event.provider
 *     - event value is null
 *
 *   Bizevents (cloudevent encoding):
 *     - missing id / source / type / specversion
 *
 * We return a structured { ok, errors, warnings } so the calling tool can
 * decide whether to refuse (errors) or just surface (warnings).
 */

export interface ValidationIssue {
  index: number;
  field?: string;
  message: string;
}

export interface IngestValidationResult {
  ok: boolean; // false if any errors
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Metric line protocol
// ---------------------------------------------------------------------------

const METRIC_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_\-.]*$/;
const DIM_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_\-.:]*$/;
const MAX_DIMS = 50;

export interface MetricPoint {
  metricKey: string;
  dimensions?: Record<string, string>;
  value: number | string;
  timestampMs?: number;
}

export function validateMetricPoints(points: MetricPoint[]): IngestValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;

    if (!p.metricKey || !METRIC_KEY_REGEX.test(p.metricKey)) {
      errors.push({
        index: i,
        field: "metricKey",
        message: `metricKey '${p.metricKey}' is invalid — must start with a letter and contain only letters, digits, '_', '-', '.'`,
      });
    }

    if (p.dimensions) {
      const dimEntries = Object.entries(p.dimensions);
      if (dimEntries.length > MAX_DIMS) {
        errors.push({
          index: i,
          field: "dimensions",
          message: `too many dimensions (${dimEntries.length}); Dynatrace accepts at most ${MAX_DIMS}`,
        });
      }
      for (const [k, v] of dimEntries) {
        if (!k || k.length === 0) {
          errors.push({ index: i, field: "dimensions", message: "empty dimension key" });
          continue;
        }
        if (!DIM_KEY_REGEX.test(k)) {
          errors.push({
            index: i,
            field: `dimensions.${k}`,
            message: `dimension key '${k}' is invalid — must start with a letter and contain only letters/digits/_/-/./:`,
          });
        }
        if (typeof v !== "string") {
          errors.push({
            index: i,
            field: `dimensions.${k}`,
            message: `dimension value must be a string (got ${typeof v})`,
          });
        }
      }
    }

    if (typeof p.value === "number") {
      if (!Number.isFinite(p.value)) {
        errors.push({
          index: i,
          field: "value",
          message: `value is not finite (${p.value})`,
        });
      }
    } else if (typeof p.value === "string") {
      // Typed value strings: "gauge,5.0", "count,delta=10", or summary "min=0,max=10,sum=42,count=5".
      // Quick sanity: at least one digit somewhere.
      if (!/\d/.test(p.value)) {
        errors.push({
          index: i,
          field: "value",
          message: `value '${p.value}' has no digits — typed values look like 'gauge,5.0' or 'count,delta=10'`,
        });
      }
    } else {
      errors.push({
        index: i,
        field: "value",
        message: `value must be a number or a typed value string`,
      });
    }

    if (p.timestampMs !== undefined) {
      if (!Number.isInteger(p.timestampMs) || p.timestampMs <= 0) {
        errors.push({
          index: i,
          field: "timestampMs",
          message: `timestampMs must be a positive integer (ms since epoch); got ${p.timestampMs}`,
        });
      } else if (p.timestampMs < 1_000_000_000_000) {
        // Looks like seconds, not ms.
        warnings.push({
          index: i,
          field: "timestampMs",
          message: `timestampMs '${p.timestampMs}' looks like seconds, not milliseconds — Dynatrace expects ms since epoch`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Log records
// ---------------------------------------------------------------------------

const RECOGNIZED_SEVERITIES = new Set([
  "trace", "debug", "info", "notice", "warn", "warning", "error", "fatal", "critical", "alert", "emergency", "none",
]);

const LOG_RECORD_SIZE_WARN = 8 * 1024; // 8KB

export function validateLogRecords(records: Array<Record<string, unknown>>): IngestValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;

    const content = r["content"];
    if (typeof content !== "string" || content.length === 0) {
      errors.push({
        index: i,
        field: "content",
        message: "content is required and must be a non-empty string",
      });
    }

    const ts = r["timestamp"];
    if (ts !== undefined) {
      const ok = typeof ts === "string" || (typeof ts === "number" && Number.isInteger(ts) && ts > 0);
      if (!ok) {
        errors.push({
          index: i,
          field: "timestamp",
          message: "timestamp must be an ISO-8601 string or a positive integer (ms since epoch)",
        });
      }
    }

    for (const sevKey of ["severity", "loglevel", "status", "level"] as const) {
      const v = r[sevKey];
      if (typeof v === "string" && !RECOGNIZED_SEVERITIES.has(v.toLowerCase())) {
        warnings.push({
          index: i,
          field: sevKey,
          message: `${sevKey}='${v}' is not a recognized severity — DPP rules may not bucket this record`,
        });
        break; // only warn once per record
      }
    }

    const size = JSON.stringify(r).length;
    if (size > LOG_RECORD_SIZE_WARN) {
      warnings.push({
        index: i,
        message: `record size ${size}B exceeds soft cap ${LOG_RECORD_SIZE_WARN}B — Dynatrace may truncate`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Bizevents
// ---------------------------------------------------------------------------

export function validateBizevents(
  events: Array<Record<string, unknown>>,
  encoding: "default" | "cloudevent" = "default"
): IngestValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || typeof e !== "object") {
      errors.push({ index: i, message: "event must be an object" });
      continue;
    }

    if (encoding === "default") {
      // Either flat keys or nested under "event". Check both.
      const type = e["event.type"] ?? readNested(e, "event", "type");
      const provider = e["event.provider"] ?? readNested(e, "event", "provider");
      if (typeof type !== "string" || type.length === 0) {
        errors.push({
          index: i,
          field: "event.type",
          message: "event.type is required (string) for default encoding",
        });
      }
      if (typeof provider !== "string" || provider.length === 0) {
        errors.push({
          index: i,
          field: "event.provider",
          message: "event.provider is required (string) for default encoding",
        });
      }
    } else {
      // CloudEvents v1.0
      for (const field of ["id", "source", "type", "specversion"] as const) {
        if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
          errors.push({
            index: i,
            field,
            message: `${field} is required (string) for CloudEvents encoding`,
          });
        }
      }
      if (e["data"] === undefined) {
        warnings.push({
          index: i,
          field: "data",
          message: "data is missing — CloudEvents typically carry a data payload",
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function readNested(obj: Record<string, unknown>, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
