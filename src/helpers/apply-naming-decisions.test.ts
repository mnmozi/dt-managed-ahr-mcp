import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock undici BEFORE importing DtClient.
vi.mock("undici", () => {
  const requestMock = vi.fn();
  class AgentStub {
    constructor(_opts?: unknown) {}
    async close() {}
  }
  return { request: requestMock, Agent: AgentStub };
});

import { request } from "undici";
import { DtClient } from "../dt-client.js";
import { AuditLog } from "../audit.js";
import { applyNamingDecisions } from "./apply-naming-decisions.js";
import { setLogLevel } from "../logger.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";

setLogLevel("error");

const requestMock = request as unknown as ReturnType<typeof vi.fn>;

function makeResp(status: number, body = ""): unknown {
  return { statusCode: status, headers: {}, body: { text: async () => body } };
}

function makeClient(): DtClient {
  process.env.DT_HTTP_BACKOFF_MS = "1";
  process.env.DT_HTTP_MAX_BACKOFF_MS = "5";
  return new DtClient({
    clusterUrl: "https://example",
    envId: "env",
    token: "t",
    clusterToken: null,
    writeToken: "w",
    tlsVerify: false,
    auditDir: "/tmp",
  });
}

let tmpDir = "";
let audit: AuditLog;

beforeEach(() => {
  requestMock.mockReset();
  tmpDir = mkdtempSync(join(tmpdir(), "apply-naming-test-"));
  audit = new AuditLog(tmpDir);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function readAuditRecords(): Array<Record<string, unknown>> {
  const files = readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];
  const text = readFileSync(join(tmpDir, files[0]!), "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const highReport: EntityNamingReport = {
  entityId: "PG-HIGH",
  entityType: "PROCESS_GROUP",
  currentName: "java",
  genericReason: "name is a bare technology / runtime",
  candidates: [
    { source: "k8s.container", name: "billing-worker", confidence: 0.92, evidence: "..." },
  ],
  topCandidate: "billing-worker",
  decision: "high_confidence",
};

const ambigReport: EntityNamingReport = {
  entityId: "PG-AMBIG",
  entityType: "PROCESS_GROUP",
  currentName: "python3",
  genericReason: "name is a bare technology / runtime",
  candidates: [
    { source: "jar.filename", name: "data-pipeline", confidence: 0.85, evidence: "..." },
    { source: "cli.arg.name", name: "kafka-consumer", confidence: 0.80, evidence: "..." },
  ],
  topCandidate: "data-pipeline",
  decision: "ambiguous",
};

describe("applyNamingDecisions", () => {
  it("happy path: writes the tag + audits with namingDecision provenance", async () => {
    requestMock.mockResolvedValueOnce(makeResp(200, JSON.stringify({ matchedEntitiesCount: 1 })));
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport],
      decisions: [
        { entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/"applied": 1/);

    // Audit row carries the namingDecision block.
    const rows = readAuditRecords();
    expect(rows).toHaveLength(1);
    const nd = rows[0]!.namingDecision as Record<string, unknown>;
    expect(nd.bucket).toBe("high_confidence");
    expect(nd.decider).toBe("engine_high");
    expect(nd.chosenName).toBe("billing-worker");
    expect((nd.engineCandidates as unknown[]).length).toBe(1);
  });

  it("refuses the whole batch if any decision fails lattice validation", async () => {
    // First decision is valid; second tries to use engine_high on an ambig report.
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport, ambigReport],
      decisions: [
        { entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" },
        { entityId: "PG-AMBIG", chosenName: "data-pipeline", source: "engine_high" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/lattice validation/);
    // No writes attempted.
    expect(requestMock).not.toHaveBeenCalled();
    // No audit rows.
    expect(existsSync(tmpDir)).toBe(true);
    expect(readAuditRecords()).toHaveLength(0);
  });

  it("continues on per-entity HTTP failure (partial success batch)", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ matchedEntitiesCount: 1 }))) // PG-HIGH ok
      .mockResolvedValueOnce(makeResp(400, JSON.stringify({ error: "bad" }))); // PG-AMBIG fails
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport, ambigReport],
      decisions: [
        { entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" },
        {
          entityId: "PG-AMBIG",
          chosenName: "data-pipeline",
          source: "ai_proposed",
          aiRationale: "jar filename is the strongest signal",
        },
      ],
    });
    expect(result.isError).toBe(true); // failed > 0
    expect(result.content[0]!.text).toMatch(/"applied": 1/);
    expect(result.content[0]!.text).toMatch(/"failed": 1/);
    const rows = readAuditRecords();
    expect(rows).toHaveLength(2);
    // Both rows have namingDecision blocks (success + error both audit).
    expect((rows[0]!.namingDecision as Record<string, unknown>).chosenName).toBe("billing-worker");
    expect((rows[1]!.namingDecision as Record<string, unknown>).chosenName).toBe("data-pipeline");
  });

  it("ai_proposed without aiRationale is refused by the lattice", async () => {
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [ambigReport],
      decisions: [
        { entityId: "PG-AMBIG", chosenName: "data-pipeline", source: "ai_proposed" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/aiRationale/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("applyNamingDecisions with createNamingRule", () => {
  it("creates a conditional-naming rule after tagging (none existing)", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ matchedEntitiesCount: 1 }))) // tag write
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ values: [] })))              // rule list
      .mockResolvedValueOnce(makeResp(201, JSON.stringify({ id: "rule-1" })));           // rule create
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport],
      decisions: [{ entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" }],
      createNamingRule: true,
      conditionalNamingType: "processGroup",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.namingRules).toHaveLength(1);
    expect(body.namingRules[0]).toMatchObject({ chosenName: "billing-worker", created: true, status: 201 });
    // rule POST audited too — and the body uses the FLAT condition shape
    // validated against live Managed 1.342 rules (no {type, conditions} wrapper).
    const rows = readAuditRecords();
    expect(rows.length).toBe(2);
    const ruleBody = rows[1]!.requestBody as { rules: Array<Record<string, unknown>> };
    expect(ruleBody.rules[0]).toHaveProperty("key");
    expect(ruleBody.rules[0]).toHaveProperty("comparisonInfo");
    expect(ruleBody.rules[0]).not.toHaveProperty("conditions");
  });

  it("skips rule creation when an existing rule already has the nameFormat", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ matchedEntitiesCount: 1 }))) // tag write
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ values: [{ id: "kargo-1", name: "kargo rule" }] }))) // list
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ nameFormat: "billing-worker" })));                   // detail
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport],
      decisions: [{ entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" }],
      createNamingRule: true,
      conditionalNamingType: "processGroup",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.namingRules[0]).toMatchObject({ created: false, skippedExistingId: "kargo-1" });
    expect(requestMock).toHaveBeenCalledTimes(3); // no create POST
  });

  it("refuses rule creation when the existing-rule list can't be fetched", async () => {
    requestMock
      .mockResolvedValueOnce(makeResp(200, JSON.stringify({ matchedEntitiesCount: 1 }))) // tag write
      .mockResolvedValue(makeResp(500, "boom"));                                          // list fails (all retries)
    const result = await applyNamingDecisions({
      client: makeClient(),
      audit,
      tool: "dt_apply_pg_naming_rule",
      reports: [highReport],
      decisions: [{ entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" }],
      createNamingRule: true,
      conditionalNamingType: "processGroup",
    });
    const body = JSON.parse(result.content[0]!.text);
    expect(body.namingRulesError).toMatch(/refusing to create rules/);
    expect(body.namingRules).toEqual([]);
  });
});
