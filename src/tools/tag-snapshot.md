# MCP tool: `dt_get_tag_snapshot`

Round 1 of the tag-strategy workflow. The piping layer for `tags.snapshot`: fetches the entity graph + tags + auto-tag rules from Dynatrace and hands them to the engine's analyzer.

**Scope rule:** the tool does NO logic. All counts / classifications / clustering live in the engine. The tool fetches and orchestrates.

---

## Tool signature

```
Name:   dt_get_tag_snapshot
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required (calls tags.snapshot analyzer)
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `lowTagThreshold` | integer | 1 | Entities with ≤ this many tags flagged as low-tag |
| `graphMode` | `"low_tag_only" \| "full" \| "none"` | `"low_tag_only"` | How much of the graph to emit |

### Response shape (success)

```json
{
  "entitiesByType": { ... },
  "keys": [ ... ],
  "keySimilarityClusters": [ ... ],
  "lowTagEntities": { ... },
  "lowTagSubgraph": { ... },
  "propagationHints": [ ... ],
  "appliedDefaults": { ... }
}
```

See [`tags.snapshot` engine doc](../../../dt-managed-engine/internal/analyze/tags/snapshot.md) for every field.

### Response shape (failure)

```json
{
  "available": false,
  "reason": "tag snapshot could not be computed",
  "error": "<message>",
  "hint": "Make sure DT_ENGINE_BIN is set and the cluster is reachable."
}
```

With `isError: true`. No fallback to TS computation.

---

## What the tool does

```
1. In parallel:
   a. Fetch all hosts (paginated) with +tags +properties
   b. Fetch all process_groups with +tags +properties +fromRelationships +toRelationships
   c. Fetch all process_group_instances with +tags +properties +fromRelationships +toRelationships
   d. Fetch all services with +tags +properties +fromRelationships +toRelationships
   e. Fetch auto-tag rules (Settings 2.0: builtin:tags.auto-tagging)

2. Reshape into engine's flat input:
   - For each entity: extract relationships by target TYPE (tolerant of
     Dynatrace naming differences across versions — we scan all relationship
     entries and pick by target type, not by relationship name)

3. Call tags.snapshot via engine_analyze.

4. Return engine output verbatim.
```

The MCP doesn't transform the analyzer output. The LLM sees what the engine emits.

---

## HTTP endpoints touched

| Endpoint | Purpose |
|---|---|
| `/api/v2/entities?entitySelector=type(HOST)&fields=+tags,+properties` | Host inventory (paginated) |
| `/api/v2/entities?entitySelector=type(PROCESS_GROUP)&fields=+tags,+properties,+fromRelationships,+toRelationships` | PG inventory |
| `/api/v2/entities?entitySelector=type(PROCESS_GROUP_INSTANCE)&fields=+tags,+properties,+fromRelationships,+toRelationships` | PGI inventory |
| `/api/v2/entities?entitySelector=type(SERVICE)&fields=+tags,+properties,+fromRelationships,+toRelationships` | Service inventory with call graph |
| `/api/v2/settings/objects?schemaIds=builtin:tags.auto-tagging` | Auto-tag rules |

### Why all four pagination passes in parallel?

For a 1000-host tenant the cumulative pagination latency dominates. Running the four fetches concurrently halves the wall-clock.

---

## Relationship handling (tolerant)

Dynatrace's relationship field names vary across cluster versions (`runsOn` vs `runs_on`, etc.). The tool doesn't hardcode names — it scans every entry in `fromRelationships` and `toRelationships`, filtering by target type:

```ts
// For each entity:
//   fromRelationships: { <some-name>: [{id, type}, ...], ... }
//   We scan all values, look for entries where target.type matches what we
//   want, and use those ids.
```

This means we tolerate version differences without code changes.

---

## Pagination semantics

| Setting | Value |
|---|---|
| pageSize | 1000 (max) |
| Max pages | 50 per entity type |
| Time window | from=now-24h, to=now |

50 × 1000 = 50,000 entities per type. Far above any realistic Managed tenant.

---

## What's NOT in this tool

- Tag aggregation / counting — engine
- Key similarity clustering — engine
- Value-format judgment — engine
- Low-tag entity filtering — engine
- Graph construction — engine
- All sorting — engine emits in stable order

---

## Examples

### Default call
```ts
dt_get_tag_snapshot({})
```
Fetches everything, returns the snapshot with the low-tag subgraph.

### Just the summary, no graph
```ts
dt_get_tag_snapshot({ graphMode: "none" })
```
Smaller response. Use when you only want the taxonomy/clusters/coverage.

### Flag entities with 0–2 tags as low-tag (default is 0–1)
```ts
dt_get_tag_snapshot({ lowTagThreshold: 2 })
```

---

## Related

- Engine analyzer: [`tags.snapshot`](../../../dt-managed-engine/internal/analyze/tags/snapshot.md)
- TS wrapper: `src/engine/analyzers/tags-snapshot.ts`
- Shared fetcher: `src/engine/tag-graph-fetcher.ts`
- Next in the loop: `dt_extract_tag_signals` (round 2a), `dt_simulate_tag_strategy` (round 2b)
