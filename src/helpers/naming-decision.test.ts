import { describe, it, expect } from "vitest";
import { validateDecision, describeDecision } from "./naming-decision.js";
import type { EntityNamingReport } from "../engine/analyzers/processgroups-naming-audit.js";
import { setLogLevel } from "../logger.js";

setLogLevel("error");

// Three canonical reports — one per bucket — that every test can pick from.
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

const noSignalReport: EntityNamingReport = {
  entityId: "PG-NONE",
  entityType: "PROCESS_GROUP",
  currentName: ":80",
  genericReason: "name is only a port number",
  candidates: [
    { source: "tech.only", name: "nginx", confidence: 0.30, evidence: "..." },
  ],
  decision: "no_signal",
};

describe("validateDecision — engine_high", () => {
  it("accepts when bucket=high_confidence AND name matches topCandidate", () => {
    const r = validateDecision(
      { entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" },
      highReport
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.decider).toBe("engine_high");
      expect(r.record.bucket).toBe("high_confidence");
      expect(r.record.engineCandidates).toHaveLength(1);
    }
  });

  it("rejects when bucket is ambiguous (no bucket upgrade)", () => {
    const r = validateDecision(
      { entityId: "PG-AMBIG", chosenName: "data-pipeline", source: "engine_high" },
      ambigReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/upgrade a bucket/);
  });

  it("rejects when chosenName != topCandidate", () => {
    const r = validateDecision(
      { entityId: "PG-HIGH", chosenName: "wrong-name", source: "engine_high" },
      highReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/topCandidate/);
  });
});

describe("validateDecision — ai_proposed", () => {
  it("accepts when bucket=ambiguous AND name in candidates AND rationale present", () => {
    const r = validateDecision(
      {
        entityId: "PG-AMBIG",
        chosenName: "kafka-consumer",
        source: "ai_proposed",
        aiRationale: "argv has --name=kafka-consumer which is more specific than the jar.",
      },
      ambigReport
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.aiRationale).toBeDefined();
      expect(r.record.decider).toBe("ai_proposed");
    }
  });

  it("rejects when bucket=high_confidence (use engine_high)", () => {
    const r = validateDecision(
      {
        entityId: "PG-HIGH",
        chosenName: "billing-worker",
        source: "ai_proposed",
        aiRationale: "I picked it",
      },
      highReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/high_confidence|engine_high|no_signal/);
  });

  it("rejects when bucket=no_signal (AI cannot upgrade)", () => {
    const r = validateDecision(
      {
        entityId: "PG-NONE",
        chosenName: "nginx",
        source: "ai_proposed",
        aiRationale: "best guess",
      },
      noSignalReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/operator only|no_signal/);
  });

  it("rejects when chosenName not in engine candidates (no inventing)", () => {
    const r = validateDecision(
      {
        entityId: "PG-AMBIG",
        chosenName: "made-up-name",
        source: "ai_proposed",
        aiRationale: "trust me",
      },
      ambigReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invent/);
  });

  it("rejects when aiRationale is empty", () => {
    const r = validateDecision(
      {
        entityId: "PG-AMBIG",
        chosenName: "data-pipeline",
        source: "ai_proposed",
        aiRationale: "   ",
      },
      ambigReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/aiRationale/);
  });

  it("rejects when aiRationale is missing", () => {
    const r = validateDecision(
      { entityId: "PG-AMBIG", chosenName: "data-pipeline", source: "ai_proposed" },
      ambigReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/aiRationale/);
  });
});

describe("validateDecision — operator_confirmed", () => {
  it("accepts when chosenName is in candidates and bucket is ambiguous", () => {
    const r = validateDecision(
      { entityId: "PG-AMBIG", chosenName: "kafka-consumer", source: "operator_confirmed" },
      ambigReport
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when bucket is no_signal (use operator_override)", () => {
    const r = validateDecision(
      { entityId: "PG-NONE", chosenName: "anything", source: "operator_confirmed" },
      noSignalReport
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/operator_override/);
  });
});

describe("validateDecision — operator_override", () => {
  it("is always allowed even with a non-candidate name", () => {
    const r = validateDecision(
      { entityId: "PG-HIGH", chosenName: "totally-different", source: "operator_override" },
      highReport
    );
    expect(r.ok).toBe(true);
  });

  it("works for no_signal entities (the intended path)", () => {
    const r = validateDecision(
      { entityId: "PG-NONE", chosenName: "manual-name", source: "operator_override" },
      noSignalReport
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateDecision — missing report", () => {
  it("rejects when entityId has no matching report", () => {
    const r = validateDecision(
      { entityId: "PG-UNKNOWN", chosenName: "x", source: "operator_override" },
      undefined
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no engine report/);
  });
});

describe("describeDecision", () => {
  it("formats bucket/decider/name for human readouts", () => {
    const r = validateDecision(
      { entityId: "PG-HIGH", chosenName: "billing-worker", source: "engine_high" },
      highReport
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(describeDecision(r.record)).toBe(
        "[high_confidence / engine_high] 'billing-worker'"
      );
    }
  });
});
