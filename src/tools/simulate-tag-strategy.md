# MCP tool: `dt_simulate_tag_strategy`

Round 2b of the tag-strategy workflow. Simulates a proposed tagging strategy against the entity graph and returns coverage statistics + the list of uncovered entities.

**Scope rule:** the tool does NO logic. All simulation lives in the engine.

---

## Tool signature

```
Name:   dt_simulate_tag_strategy
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `strategy` | `Record<string, { extractFrom: string[]; fallback?: string }>` | required | Per-key extraction recipe |
| `scopeEntityTypes` | `("HOST" \| "PROCESS_GROUP" \| "PROCESS_GROUP_INSTANCE" \| "SERVICE")[]` | all 4 | Restrict simulation scope |

### Source DSL for `extractFrom`

| Spec | Resolves to |
|---|---|
| `property:<field>` | Top-level property field |
| `property:<field>:<subkey>` | Nested map field's subkey |
| `awsTag:<Key>` / `azureTag:<Key>` / `gcpTag:<Key>` | Cloud tag value (case-insensitive key match) |
| `k8sLabel:<key>` | k8s label value |
| `envVar:<NAME>` | env var value |
| `hostGroup.name` | host group name |
| `hostName.token[N]` | N-th token of hostname split on `-_./ ` |
| `containmentParent:tag:<key>` | First non-empty tag on a parent |
| `containmentDescendantMajority:tag:<key>` | Descendant majority (≥66%) |
| `callGraphMajority:tag:<key>` | Call-neighbor majority |
| `siblingTag:<key>` | First non-empty sibling tag |
| `fallback:<literal>` | Literal default (terminal) |

Plus `fallback: "value"` as a sibling field — applied if all `extractFrom` entries are empty.

### Response shape

```json
{
  "coveragePerKey": {
    "team": {
      "perType":  { "HOST": { covered, uncovered, coverage }, ... },
      "overall":  { covered, uncovered, coverage }
    }
  },
  "uncoveredEntities": [
    { "entityId": "...", "type": "HOST", "missingKeys": [{ "key": "team", "sourcesTried": [...] }] }
  ],
  "achievableCoverage": 0.85,
  "appliedDefaults": { "scopeEntityTypes": [...] }
}
```

See [`tags.strategy_coverage` engine doc](../../../dt-managed-engine/internal/analyze/tags/strategy_coverage.md) for full semantics.

---

## What the tool does

```
1. Fetch the entity graph (same as dt_get_tag_snapshot).
2. Call tags.strategy_coverage via engine_analyze with:
   - flat entity input
   - strategy
   - scopeEntityTypes (or default all)
3. Return engine output.
```

---

## HTTP endpoints touched

Same as snapshot: 4 paginated entity fetches in parallel. No additional endpoints needed — the simulation is pure logic over the graph.

---

## Examples

### Simulate a team strategy across hosts
```ts
dt_simulate_tag_strategy({
  strategy: {
    team: {
      extractFrom: ["awsTag:Team", "envVar:OWNING_TEAM", "containmentParent:tag:team"]
    }
  },
  scopeEntityTypes: ["HOST"]
})
```
Returns: % of hosts where one of those three sources produces a value.

### Multi-key strategy with fallback
```ts
dt_simulate_tag_strategy({
  strategy: {
    team: { extractFrom: ["awsTag:Team", "envVar:OWNING_TEAM"] },
    env:  { extractFrom: ["hostGroup.name"], fallback: "default" }
  }
})
```
`team` may be uncovered for hosts lacking both sources; `env` is always covered (fallback).

### Use call-graph inheritance for services
```ts
dt_simulate_tag_strategy({
  strategy: {
    team: {
      extractFrom: [
        "containmentParent:tag:team",
        "callGraphMajority:tag:team",
        "siblingTag:team"
      ]
    }
  },
  scopeEntityTypes: ["SERVICE"]
})
```

---

## What's NOT in this tool

- Strategy evaluation logic — engine
- Coverage math — engine
- Achievable-coverage roll-up — engine
- Auto-tag rule payload generation — that's downstream of strategy approval, handled by the AI generating payloads + `dt_create_settings`

---

## Related

- Engine analyzer: [`tags.strategy_coverage`](../../../dt-managed-engine/internal/analyze/tags/strategy_coverage.md)
- TS wrapper: `src/engine/analyzers/tags-strategy-coverage.ts`
- Loop neighbors: `dt_get_tag_snapshot` (round 1), `dt_extract_tag_signals` (round 2a)
- Downstream: once a strategy reaches acceptable coverage, the AI generates auto-tag rule payloads and applies them via `dt_create_settings` against `builtin:tags.auto-tagging`.
