import { Agent, request } from "undici";
import type { DtConfig } from "./config.js";

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

type Scope = "env" | "cluster";

export interface GetOptions {
  scope?: Scope;
  query?: Record<string, string | number | boolean | undefined>;
}

export class DtClient {
  private readonly dispatcher: Agent;

  constructor(private readonly cfg: DtConfig) {
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: cfg.tlsVerify },
    });
  }

  private baseFor(scope: Scope): string {
    if (scope === "cluster") return this.cfg.clusterUrl;
    return `${this.cfg.clusterUrl}/e/${this.cfg.envId}`;
  }

  private tokenFor(scope: Scope): string {
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

  async get<T = unknown>(path: string, opts: GetOptions = {}): Promise<T> {
    const scope: Scope = opts.scope ?? "env";
    const base = this.baseFor(scope);
    const token = this.tokenFor(scope);

    const url = new URL(base + (path.startsWith("/") ? path : "/" + path));
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await request(url, {
      method: "GET",
      headers: {
        Authorization: `Api-Token ${token}`,
        Accept: "application/json",
      },
      dispatcher: this.dispatcher,
    });

    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new DtApiError(res.statusCode, "GET", url.pathname + url.search, text);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
