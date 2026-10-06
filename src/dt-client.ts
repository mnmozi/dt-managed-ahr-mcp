import { Agent, request, type Dispatcher } from "undici";
import type { DtConfig } from "./config.js";
import { makeLogger, type Logger } from "./logger.js";

export class DtApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`[dt-mcp ${method} ${path}] HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "DtApiError";
  }
}

export class WriteNotEnabledError extends Error {
  constructor(tool: string) {
    super(
      `[dt-mcp] ${tool} requires DT_WRITE_TOKEN (or DT_WRITE_TOKEN_FILE) to be set. ` +
        `Without it the MCP runs read-only. The write token should have only the ` +
        `scopes that tool needs (e.g. settings.write, metrics.ingest, WriteConfig).`
    );
    this.name = "WriteNotEnabledError";
  }
}

type Scope = "env" | "cluster";

export interface GetOptions {
  scope?: Scope;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface WriteOptions {
  /**
   * When provided, used as the Content-Type header and the body is sent as-is
   * (not JSON.stringify'd). Used by the metric-ingest line protocol which
   * expects text/plain.
   */
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface RequestResult<T> {
  status: number;
  path: string;
  data: T;
}

/** Retry + timeout policy. Configurable via env vars at startup. */
export interface RetryPolicy {
  /** Per-request timeout in ms. Default 60_000. Env: DT_HTTP_TIMEOUT_MS. */
  timeoutMs: number;
  /** Max retry attempts (total = 1 + maxRetries). Default 3. Env: DT_HTTP_MAX_RETRIES. */
  maxRetries: number;
  /** Initial backoff between retries in ms. Default 1000. Env: DT_HTTP_BACKOFF_MS. */
  baseBackoffMs: number;
  /** Cap on a single backoff wait. Default 30_000. Env: DT_HTTP_MAX_BACKOFF_MS. */
  maxBackoffMs: number;
}

/** Status codes we retry on (idempotent retries; we only retry safe verbs by default). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Verbs we consider safe to retry without explicit caller opt-in. */
const SAFE_VERBS = new Set(["GET", "HEAD"]);

function intFromEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

function loadRetryPolicy(): RetryPolicy {
  return {
    timeoutMs: intFromEnv("DT_HTTP_TIMEOUT_MS", 60_000),
    maxRetries: intFromEnv("DT_HTTP_MAX_RETRIES", 3),
    baseBackoffMs: intFromEnv("DT_HTTP_BACKOFF_MS", 1_000),
    maxBackoffMs: intFromEnv("DT_HTTP_MAX_BACKOFF_MS", 30_000),
  };
}

/** Internal request shape. */
interface ExecRequest {
  method: string;
  url: URL;
  token: string;
  body?: string | undefined;
  contentType?: string;
  /** Method-level override of the policy's default "safe-retry" choice. */
  forceRetry?: boolean;
}

export class DtClient {
  private readonly dispatcher: Agent;
  private readonly log: Logger;
  private readonly policy: RetryPolicy;

  constructor(private readonly cfg: DtConfig) {
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: cfg.tlsVerify },
    });
    this.log = makeLogger("http");
    this.policy = loadRetryPolicy();
    this.log.info("dt-client initialized", {
      clusterUrl: cfg.clusterUrl,
      envId: cfg.envId,
      tlsVerify: cfg.tlsVerify,
      writeEnabled: Boolean(cfg.writeToken),
      timeoutMs: this.policy.timeoutMs,
      maxRetries: this.policy.maxRetries,
    });
  }

  // ---------- shared helpers ----------

  private baseFor(scope: Scope): string {
    if (scope === "cluster") return this.cfg.clusterUrl;
    return `${this.cfg.clusterUrl}/e/${this.cfg.envId}`;
  }

  private readTokenFor(scope: Scope): string {
    if (scope === "cluster") {
      if (!this.cfg.clusterToken) {
        throw new Error(
          "cluster-scoped call requested but DT_CLUSTER_TOKEN_FILE is not configured"
        );
      }
      return this.cfg.clusterToken;
    }
    return this.cfg.token;
  }

  private writeToken(tool: string): string {
    if (!this.cfg.writeToken) throw new WriteNotEnabledError(tool);
    return this.cfg.writeToken;
  }

  private buildUrl(
    base: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): URL {
    const url = new URL(base + (path.startsWith("/") ? path : "/" + path));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  /** True when DT_WRITE_TOKEN (or _FILE) was provided at startup. */
  get writeEnabled(): boolean {
    return Boolean(this.cfg.writeToken);
  }

  /** Expose policy (mainly for tests). */
  get retryPolicy(): RetryPolicy {
    return this.policy;
  }

  /**
   * Centralized request executor. Handles:
   *   - per-attempt timeout via AbortController
   *   - retry on 408/425/429/5xx + network errors for SAFE verbs (GET, HEAD)
   *     OR when caller passes forceRetry=true (used by read-via-POST endpoints)
   *   - respects Retry-After header on 429 (seconds or HTTP-date)
   *   - exponential backoff with jitter for non-429 retries
   *   - logs every attempt at debug, retries at info/warn, final failure at error
   *
   * NOT-retried by default: POST/PUT/DELETE/PATCH — these may have side effects
   * even on failure. Caller passes forceRetry=true on safe POSTs (read-via-POST
   * endpoints like /api/v2/logs/search).
   */
  private async exec<T = unknown>(req: ExecRequest): Promise<RequestResult<T>> {
    const verb = req.method;
    const pathOnly = req.url.pathname + req.url.search;
    const retryable = req.forceRetry || SAFE_VERBS.has(verb);
    const maxAttempts = retryable ? 1 + this.policy.maxRetries : 1;
    const start = Date.now();

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reqStart = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);

      try {
        this.log.debug("http request", {
          verb,
          path: pathOnly,
          attempt,
          maxAttempts,
        });

        const res = await request(req.url, {
          method: verb as Dispatcher.HttpMethod,
          headers: this.headersFor(req),
          body: req.body,
          dispatcher: this.dispatcher,
          signal: controller.signal,
        });
        // Keep the timer armed until the body is fully read: a 1000-entity
        // page with +properties can take longer to stream than the headers.
        const text = await res.body.text();
        clearTimeout(timer);
        const elapsedMs = Date.now() - reqStart;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.log.debug("http ok", {
            verb,
            path: pathOnly,
            status: res.statusCode,
            attempt,
            elapsedMs,
          });
          const data = text ? (tryParse<T>(text) as T) : (undefined as T);
          return { status: res.statusCode, path: pathOnly, data };
        }

        // Non-2xx
        const err = new DtApiError(res.statusCode, verb, pathOnly, text);
        if (RETRYABLE_STATUS.has(res.statusCode) && attempt < maxAttempts && retryable) {
          const retryAfter = parseRetryAfter(res.headers["retry-after"]);
          const backoff = retryAfter ?? this.computeBackoff(attempt);
          this.log.warn("http retryable failure; backing off", {
            verb,
            path: pathOnly,
            status: res.statusCode,
            attempt,
            elapsedMs,
            backoffMs: backoff,
            retryAfter: retryAfter ?? undefined,
            bodyPreview: text.slice(0, 200),
          });
          await sleep(backoff);
          lastErr = err;
          continue;
        }
        this.log.warn(
          RETRYABLE_STATUS.has(res.statusCode) && retryable
            ? "http retries exhausted"
            : "http non-retryable failure",
          {
            verb,
            path: pathOnly,
            status: res.statusCode,
            attempt,
            elapsedMs,
            bodyPreview: text.slice(0, 200),
          }
        );
        throw err;
      } catch (err) {
        clearTimeout(timer);
        // Network/abort error path
        if (err instanceof DtApiError) {
          // already logged + handled above; just rethrow at end-of-attempts
          throw err;
        }
        const elapsedMs = Date.now() - reqStart;
        const aborted = controller.signal.aborted;
        const msg = aborted
          ? `timeout after ${this.policy.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        if (attempt < maxAttempts && retryable) {
          const backoff = this.computeBackoff(attempt);
          this.log.warn("http network error; backing off", {
            verb,
            path: pathOnly,
            attempt,
            elapsedMs,
            backoffMs: backoff,
            error: msg,
            aborted,
          });
          await sleep(backoff);
          lastErr = err;
          continue;
        }
        this.log.error("http failed after all retries", {
          verb,
          path: pathOnly,
          attempts: attempt,
          totalElapsedMs: Date.now() - start,
          error: msg,
          aborted,
        });
        throw err;
      }
    }
    // Unreachable except if we ran out of retries on a DtApiError.
    if (lastErr) throw lastErr;
    throw new Error("dt-client: exhausted retries without error or success (impossible)");
  }

  private headersFor(req: ExecRequest): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Api-Token ${req.token}`,
      Accept: "application/json",
    };
    if (req.body !== undefined) {
      headers["Content-Type"] = req.contentType ?? "application/json";
    }
    return headers;
  }

  /** Exponential backoff with jitter. attempt is 1-indexed. */
  private computeBackoff(attempt: number): number {
    const exp = this.policy.baseBackoffMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exp, this.policy.maxBackoffMs);
    // Full jitter: random in [0, capped]
    return Math.floor(Math.random() * capped);
  }

  // ---------- public surface ----------

  async get<T = unknown>(path: string, opts: GetOptions = {}): Promise<T> {
    const scope: Scope = opts.scope ?? "env";
    const url = this.buildUrl(this.baseFor(scope), path, opts.query);
    const token = this.readTokenFor(scope);
    const result = await this.exec<T>({ method: "GET", url, token });
    return result.data;
  }

  async post<T = unknown>(
    tool: string,
    path: string,
    body: unknown,
    opts: WriteOptions = {}
  ): Promise<RequestResult<T>> {
    const token = this.writeToken(tool);
    const url = this.buildUrl(this.baseFor("env"), path, opts.query);
    const encoded = encodeBody(body, opts.contentType);
    return this.exec<T>({ method: "POST", url, token, body: encoded, contentType: opts.contentType });
  }

  async put<T = unknown>(
    tool: string,
    path: string,
    body: unknown,
    opts: WriteOptions = {}
  ): Promise<RequestResult<T>> {
    const token = this.writeToken(tool);
    const url = this.buildUrl(this.baseFor("env"), path, opts.query);
    const encoded = encodeBody(body, opts.contentType);
    return this.exec<T>({ method: "PUT", url, token, body: encoded, contentType: opts.contentType });
  }

  /**
   * POST that uses the READ token, not the write token. For Dynatrace
   * endpoints that semantically read but use POST for body-shape reasons.
   * Retries enabled (forceRetry: true) since these are semantically idempotent.
   */
  async postRead<T = unknown>(
    path: string,
    body: unknown,
    opts: WriteOptions = {}
  ): Promise<RequestResult<T>> {
    const url = this.buildUrl(this.baseFor("env"), path, opts.query);
    const encoded = encodeBody(body, opts.contentType);
    return this.exec<T>({
      method: "POST",
      url,
      token: this.cfg.token,
      body: encoded,
      contentType: opts.contentType,
      forceRetry: true,
    });
  }

  async delete<T = unknown>(
    tool: string,
    path: string,
    opts: WriteOptions = {}
  ): Promise<RequestResult<T>> {
    const token = this.writeToken(tool);
    const url = this.buildUrl(this.baseFor("env"), path, opts.query);
    return this.exec<T>({ method: "DELETE", url, token });
  }

  async patch<T = unknown>(
    tool: string,
    path: string,
    body: unknown,
    opts: WriteOptions = {}
  ): Promise<RequestResult<T>> {
    const token = this.writeToken(tool);
    const url = this.buildUrl(this.baseFor("env"), path, opts.query);
    const encoded = encodeBody(body, opts.contentType);
    return this.exec<T>({ method: "PATCH", url, token, body: encoded, contentType: opts.contentType });
  }

  /**
   * Introspect a token via POST /api/v2/apiTokens/lookup. The token being
   * inspected goes in the BODY; `authToken` authenticates the call and needs
   * the apiTokens.read scope. Goes through the shared executor so it gets the
   * same timeout / retry / logging as everything else (retry is safe: the
   * endpoint is read-only).
   */
  async lookupToken<T = unknown>(tokenToInspect: string, authToken: string): Promise<RequestResult<T>> {
    const url = this.buildUrl(this.baseFor("env"), "/api/v2/apiTokens/lookup");
    return this.exec<T>({
      method: "POST",
      url,
      token: authToken,
      body: JSON.stringify({ token: tokenToInspect }),
      forceRetry: true,
    });
  }

  /** The configured read / write tokens, for tools that need to introspect them. Never log these. */
  get tokens(): { read: string; write: string | null; clusterConfigured: boolean } {
    return { read: this.cfg.token, write: this.cfg.writeToken, clusterConfigured: Boolean(this.cfg.clusterToken) };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

function encodeBody(body: unknown, contentType?: string): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (contentType) return body as string; // raw content path (text/plain etc.)
  return JSON.stringify(body);
}

/** Parse Retry-After header (seconds or HTTP-date) → ms. Returns null when unparseable. */
function parseRetryAfter(h: string | string[] | undefined): number | null {
  if (!h) return null;
  const s = Array.isArray(h) ? h[0] : h;
  if (!s) return null;
  const seconds = Number.parseInt(s, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // Try HTTP-date
  const date = Date.parse(s);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function tryParse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
