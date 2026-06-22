# MCP tool: `dt_get_activegate_versions`

The piping layer for the ActiveGate fleet audit. Fetches `/api/v2/activeGates` (paginated), fetches the cluster's per-OS latest gateway version, hands both to the engine's `activegate.distribution` analyzer.

**Scope rule:** the tool does NO logic. All counts / classifications / capability maps / "behind latest" math live in the engine. The tool fetches and orchestrates.

---

## Tool signature

```
Name:   dt_get_activegate_versions
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required (calls activegate.distribution analyzer)
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `includeAgs` | boolean | `false` | If true, includes the full raw AG inventory alongside the summary. |
| `skipLatestLookup` | boolean | `false` | If true, skip the per-OS gateway latest fetch. AGs with versions land in `activeGatesWithoutOsLatestReference`. |
| `osTypeOverrides` | `Record<string,string>` | `{}` | Pin a "latest" version per OS, applied AFTER the cluster lookup. |

### Response shape (success)

```json
{
  "summary": { /* engine output — see distribution.md */ },
  "latestLookupErrors": [{ "osType": "AIX", "error": "HTTP 404" }],
  "activeGates": [ /* raw inventory — only if includeAgs:true */ ]
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
With `isError: true`. No fallback to TS computation.

---

## What the tool does

```
1. Paginate /api/v2/activeGates until exhausted (or 50-page cap):
   - First page: pageSize=500
   - Next pages: nextPageKey

2. Collect distinct osType values from the inventory.

3. If !skipLatestLookup, for each observed OS (excluding UNKNOWN / ""):
     Try GET /api/v1/deployment/installer/gateway/{os}/default/latest/metainfo
       → { latestGatewayVersion, latestAgentVersion } — either accepted
     If 4xx/5xx, try GET /api/v1/deployment/installer/gateway/versions/{os}
       → { availableVersions: [...] } — last element treated as latest
     If both fail, record in latestLookupErrors[].

4. Apply osTypeOverrides (caller wins for any OS they pin).

5. Engine: analyzeActiveGateDistribution(client, { activeGates, latestVersionsByOs }).

6. Return: { summary, latestLookupErrors?, activeGates? }
```

---

## HTTP endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v2/activeGates` | GET | AG inventory (paginated) |
| `/api/v1/deployment/installer/gateway/{os}/default/latest/metainfo` | GET | Per-OS latest gateway version (primary). The response field varies by version (`latestGatewayVersion` or `latestAgentVersion`); we accept either. |
| `/api/v1/deployment/installer/gateway/versions/{os}` | GET | Fallback for per-OS — last element of `availableVersions` |

OS path segment is lowercased before the URL (`LINUX` → `linux`). Map keys we send to the engine stay uppercase to match the inventory.

### Failure modes

| Failure | Behavior |
|---|---|
| `/api/v2/activeGates` fails | Tool errors; no partial result. |
| One OS's latest lookup fails on both endpoints | Recorded in `latestLookupErrors`; tool continues. Engine emits the OS in `activeGatesWithoutOsLatestReference`. |
| Engine subprocess fails to spawn | Tool returns `available:false` with isError + install hint. |

---

## Pagination semantics

| Property | Value |
|---|---|
| Initial pageSize | 500 |
| Max pages | 50 (cap) |
| Behavior at cap | Stops; partial inventory passed to engine. Engine's totalActiveGates reflects what was fetched. |

50 pages × 500 = 25,000 AGs. Far above any realistic Managed deployment.

---

## What's NOT in this tool

- Any version comparison logic — engine
- Any capability/network-zone analysis — engine
- Any misconfigured detection — engine
- Any sort beyond what the engine emits — engine emits in deterministic order

---

## Examples

### Default call
```ts
dt_get_activegate_versions({})
```
Fetches everything, looks up latest per OS, returns just the summary.

### Skip the lookup (faster, less informative)
```ts
dt_get_activegate_versions({ skipLatestLookup: true })
```
Outdated count will be 0; all versioned AGs land in `activeGatesWithoutOsLatestReference`.

### Pin a Linux latest for testing
```ts
dt_get_activegate_versions({ osTypeOverrides: { "LINUX": "1.300.0" } })
```

### Full inventory included
```ts
dt_get_activegate_versions({ includeAgs: true })
```

---

## Related

- Engine analyzer: [`activegate.distribution`](../../../dt-managed-engine/internal/analyze/activegate/distribution.md)
- TS wrapper: `src/engine/analyzers/activegate-distribution.ts`
- Engine subprocess: managed by `src/engine/engine-singleton.ts`
- **Future**: a check `CHECK_ACTIVEGATE_BEHIND_LATEST` could consume the same data and produce Findings per outdated AG.
