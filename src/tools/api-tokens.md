# MCP tool: `dt_get_api_tokens`

The piping layer for the API token security audit. Fetches `/api/v2/apiTokens` (paginated), passes the result + `Date.now()` to the engine's `token.security_audit` analyzer.

**Scope rule:** the tool does NO logic. All security classification + distributions live in the engine. The tool fetches and orchestrates.

---

## Tool signature

```
Name:   dt_get_api_tokens
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required (calls token.security_audit analyzer)
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `includeTokens` | boolean | `false` | If true, includes the raw token list (metadata only — token values never exist on this endpoint). |
| `staleUsageThresholdDays` | integer | `90` | Tokens last used more than this many days ago are flagged stale. |
| `highPrivilegeScopes` | string[] | (engine default — 6 scopes) | Scopes that mark a token as high-privilege. |

### Response shape (success)

```json
{
  "summary": { /* engine output — see security_audit.md */ },
  "tokens": [ /* raw inventory — only if includeTokens:true */ ]
}
```

### Response shape (engine unavailable)

```json
{
  "available": false,
  "reason": "engine unavailable — compute could not run",
  "error": "<spawn error>",
  "hint": "Set DT_ENGINE_BIN to the path of dt-engine."
}
```

---

## What the tool does

```
1. Paginate /api/v2/apiTokens (up to 50 pages × 500 = 25,000 tokens):
   - First page includes a curated `fields` projection
     (id,name,owner,enabled,personalAccessToken,creationDate,expirationDate,
      lastUsedDate,scopes,modifiedDate)
   - Subsequent pages: nextPageKey

2. Engine: analyzeTokenSecurityAudit({
     apiTokens: all,
     nowMillis: Date.now(),
     staleUsageThresholdDays: <override or unset>,
     highPrivilegeScopes: <override or unset>
   })

3. Return: { summary, tokens? }
```

### Why `nowMillis` is passed at call time

The engine analyzer must be a pure function — same inputs → same outputs. It can't read `time.Now()` because that would make the output non-deterministic.

So the MCP passes `Date.now()` at request time. Two consequences:

- Two calls a minute apart can produce slightly different `ageDays`/`unusedDays` values — expected and correct.
- Tests pin a fixed `nowMillis` so the golden output is reproducible.

This is a Dynatrace-engine doctrine choice; not a limitation.

---

## HTTP endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v2/apiTokens` | GET | Token metadata inventory (paginated) |

That's it. No second endpoint, no version lookup. Simpler than ActiveGate/OneAgent.

### Failure modes

| Failure | Behavior |
|---|---|
| `/api/v2/apiTokens` fails | Tool errors; no partial result. |
| Engine subprocess fails | `available:false` with install hint. |

---

## Pagination semantics

| Property | Value |
|---|---|
| Initial pageSize | 500 |
| Max pages | 50 |
| Behavior at cap | Stops; partial inventory passed to engine. |

---

## What's NOT in this tool

- Any date arithmetic — engine
- Any security classification — engine
- Any sample trimming — engine (capped at 50 per category)
- Any sort — engine emits in deterministic order

---

## Examples

### Default call
```ts
dt_get_api_tokens({})
```
Full audit with default thresholds. Returns summary only.

### Stricter stale threshold
```ts
dt_get_api_tokens({ staleUsageThresholdDays: 30 })
```
Flag tokens unused for 30+ days instead of 90+.

### Custom high-priv scope set
```ts
dt_get_api_tokens({
  highPrivilegeScopes: ["WriteConfig", "settings.write", "metrics.ingest"]
})
```
Widens the high-privilege definition to include `metrics.ingest`. The `appliedDefaults.highPrivilegeScopes` in the response will reflect this.

### Include full inventory
```ts
dt_get_api_tokens({ includeTokens: true })
```

---

## Related

- Engine analyzer: [`token.security_audit`](../../../dt-managed-engine/internal/analyze/token/security_audit.md)
- Existing check: `CHECK_TOKEN_NEVER_USED` (engine, produces Findings)
- TS wrapper: `src/engine/analyzers/token-security-audit.ts`
- **Future**: add checks `CHECK_TOKEN_NO_EXPIRATION`, `CHECK_TOKEN_EXPIRED`, `CHECK_TOKEN_HIGH_PRIVILEGE` consuming this analyzer's output.
