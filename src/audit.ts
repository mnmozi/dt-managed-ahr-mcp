import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditRecord {
  timestamp: string;
  tool: string;
  method: string;
  path: string;
  validateOnly: boolean;
  schemaId?: string;
  scope?: string;
  objectId?: string;
  status: number | "error";
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
  /** Optional payload fingerprint (sha256-prefix) for create-* dedup detection. */
  payloadFingerprint?: string;
  /** Optional naming-decision provenance (see helpers/naming-decision.ts). */
  namingDecision?: NamingDecisionRecord;
}

/**
 * Provenance block written for every naming-rule write. Lets us answer
 * "why is PG-X named 'orders-api'?" six months later by walking the audit
 * log: the engine's candidates, the bucket it fell into, who decided, and
 * the AI's rationale if it was AI-proposed.
 */
export interface NamingDecisionRecord {
  entityId: string;
  bucket: "high_confidence" | "ambiguous" | "no_signal";
  decider:
    | "engine_high"
    | "ai_proposed"
    | "operator_confirmed"
    | "operator_override";
  chosenName: string;
  engineCandidates: Array<{
    source: string;
    name: string;
    confidence: number;
  }>;
  aiRationale?: string;
}

export class AuditLog {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  private fileForToday(): string {
    const day = new Date().toISOString().slice(0, 10);
    return join(this.dir, `${day}.jsonl`);
  }

  write(record: AuditRecord): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.fileForToday(), line, "utf8");
  }

  /**
   * Read today's audit log and return the most recent entries for a given
   * tool. Used by the payload-fingerprint dedup detector. Cheap because the
   * log is small (one day's writes) and only the create-* tools call it.
   * Silently returns [] if no log file exists yet.
   */
  recentForTool(tool: string, limit = 200): AuditRecord[] {
    const path = this.fileForToday();
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out: AuditRecord[] = [];
    const lines = text.split("\n");
    // Walk from the end — newest first.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      try {
        const rec = JSON.parse(line) as AuditRecord;
        if (rec.tool === tool) out.push(rec);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}
