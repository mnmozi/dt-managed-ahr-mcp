# MCP tool: `dt_extract_tag_signals`

Round 2a of the tag-strategy workflow. The piping layer for `tags.signal_extraction`: fetches the entity graph + the ownership team directory and hands them to the engine.

**Scope rule:** the tool does NO logic. All extraction + confidence scoring + consensus picks live in the engine.

---

## Tool signature

```
Name:   dt_extract_tag_signals
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `targetKeys` | `string[]` | required | Tag keys to find candidate values for |
| `entityIds` | `string[]` | (all) | Specific entities to process |
| `existingTagValues` | `Record<string, string[]>` | `{}` | Per-key list of existing values; boosts confidence on matches |
| `skipOwnershipTeamLookup` | boolean | `false` | Skip fetching `builtin:ownership.teams` |
| `callGraphMajorityThreshold` | number | 0.66 | Fraction of neighbors needed for majority signal |
| `consensusMinConfidence` | number | 0.70 | Min confidence for a value to be the consensus pick |
| `consensusMinSources` | integer | 2 | Min distinct sources required for consensus |

### Response shape

```json
{
  "entities": [
    {
      "entityId": "...",
      "type": "...",
      "candidates": { "team": [Candidate, ...] },
      "consensus": { "team": ConsensusValue }
    }
  ],
  "summary": { "processedEntities": N, "entitiesWithConsensus": M, ... },
  "appliedDefaults": { ... }
}
```

See [`tags.signal_extraction` engine doc](../../../dt-managed-engine/internal/analyze/tags/signal_extraction.md) for full shape.

---

## What the tool does

```
1. In parallel:
   a. Fetch the entity graph (same as dt_get_tag_snapshot)
   b. Fetch ownership.teams (unless skipOwnershipTeamLookup)

2. Call tags.signal_extraction via engine_analyze with:
   - flat entity input
   - target keys
   - entitiesToProcess (or omit for all)
   - existingTagValues passed through
   - ownershipTeams from step 1b

3. Return engine output.
```

---

## HTTP endpoints touched

| Endpoint | Purpose |
|---|---|
| `/api/v2/entities?...` × 4 entity types | Entity graph (paginated, parallel) |
| `/api/v2/settings/objects?schemaIds=builtin:ownership.teams` | Ownership team directory (if not skipped) |

The ownership directory fetch is tolerant — if the schema isn't on the cluster (older Managed versions), the call returns empty and we proceed without it. No error surfaces to the user.

---

## How `existingTagValues` should be populated

Typical workflow:

```ts
// Round 1
const snap = await dt_get_tag_snapshot({});

// Build existingTagValues from snapshot's keys
const existingTagValues = {};
for (const k of snap.summary.keys) {
  existingTagValues[k.key] = k.distinctValues;
}

// Round 2a
const signals = await dt_extract_tag_signals({
  targetKeys: ["team", "project"],
  existingTagValues,
  entityIds: snap.summary.lowTagEntities.HOST.map(e => e.entityId)
});
```

The MCP tool doesn't auto-populate this for you — that's a tag-orchestrator concern at the LLM layer. We could add a `useSnapshotForExistingValues` flag later if it becomes pain.

---

## Examples

### Extract candidates for team across every untagged entity
```ts
dt_extract_tag_signals({
  targetKeys: ["team"]
})
```
Processes ALL entities. Heavy — use `entityIds` to scope.

### Scoped extraction
```ts
dt_extract_tag_signals({
  targetKeys: ["team", "project"],
  entityIds: ["HOST-A", "HOST-B", "SVC-X"],
  existingTagValues: { team: ["foo","bar"], project: ["alpha","beta"] }
})
```

### Tighter consensus threshold
```ts
dt_extract_tag_signals({
  targetKeys: ["team"],
  consensusMinConfidence: 0.85,
  consensusMinSources: 3
})
```
Only emit consensus picks when ≥3 sources agree at ≥0.85 confidence.

---

## What's NOT in this tool

- Signal extraction logic — engine
- Confidence scoring — engine
- Consensus picking — engine
- Graph walking — engine

---

## Related

- Engine analyzer: [`tags.signal_extraction`](../../../dt-managed-engine/internal/analyze/tags/signal_extraction.md)
- TS wrapper: `src/engine/analyzers/tags-signal-extraction.ts`
- Loop neighbors: `dt_get_tag_snapshot` (round 1), `dt_simulate_tag_strategy` (round 2b)
