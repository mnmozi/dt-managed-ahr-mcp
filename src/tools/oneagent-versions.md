# MCP tool: `dt_get_oneagent_versions`

The piping layer for the OneAgent rollout health audit. Fetches data from the cluster, fetches the per-OS "latest available" reference, hands both to the engine's `oneagent.distribution` analyzer, returns the structured result.

**Scope rule (from project doctrine):** this tool does NO logic. All counts, comparisons, classifications, and "behind latest" math live in the engine. The tool only orchestrates: fetch → fetch → call engine → return.

---

## Tool signature

```
Name:   dt_get_oneagent_versions
Class:  Read tool (no DT_WRITE_TOKEN required)
Engine: Required (calls oneagent.distribution analyzer)
```

### Input schema

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `includeHosts` | boolean | `false` | When true, includes the full raw host inventory in the response alongside the summary. Default false to keep response size small (the summary is much smaller than the inventory). |
| `skipLatestLookup` | boolean | `false` | When true, skips the second HTTP call (per-OS latest fetch). The engine then runs with an empty `latestVersionsByOs`, so every host with a version lands in `hostsWithoutOsLatestReference`. Useful when the deployment installer endpoint is unavailable or the token lacks scope. |
| `osTypeOverrides` | `Record<string, string>` | `{}` | Manually pin a "latest" version per OS. Applied AFTER the cluster lookup, so it overrides whatever the cluster reported. Useful for testing or when the cluster's reported latest is wrong. Example: `{"LINUX": "1.295.0"}`. |

### Response shape (success)

```json
{
  "summary": { /* full engine output — see distribution.md */ },
  "latestLookupErrors": [
    { "osType": "AIX_PPC", "error": "HTTP 404" }
  ],
  "hosts": [ /* raw /api/v2/oneagents host entries — only if includeHosts:true */ ]
}
```

- `summary` is the engine analyzer's output, passed through verbatim. See [engine docs](../../../dt-managed-engine/internal/analyze/oneagent/distribution.md) for every field.
- `latestLookupErrors` is only present when at least one per-OS latest fetch failed. Omitted otherwise.
- `hosts` is only present when `includeHosts: true`.

### Response shape (engine unavailable)

```json
{
  "available": false,
  "reason": "engine unavailable — compute could not run",
  "error": "<spawn error message>",
  "hint": "Set DT_ENGINE_BIN to the path of dt-engine, or build via `scripts/install-engine.sh`."
}
```

With `isError: true`. The tool refuses to fall back to TS-side computation — the engine is a hard requirement (per the architecture decision).

---

## What the tool does (step by step)

```
1. Paginate /api/v2/oneagents until exhausted (or hits 200-page cap):
   - First page: GET ?pageSize=500
   - Subsequent pages: GET ?nextPageKey=<key>
   - Accumulate every page's hosts[] into a single in-memory list.

2. Scan host entries to collect the set of distinct osType values
   that actually appear in this tenant.

3. If !skipLatestLookup:
     For each observed OS (excluding "UNKNOWN" / ""):
       Try GET /api/v1/deployment/installer/agent/{os}/default/latest/metainfo
         → expects { latestAgentVersion: "1.295.0" }
         → on success: latestVersionsByOs[os] = latestAgentVersion
       If that fails:
         Try GET /api/v1/deployment/installer/agent/versions/{os}
           → expects { availableVersions: [...] }
           → on success: latestVersionsByOs[os] = last element of availableVersions
       If both fail:
         Record { osType, error } in latestLookupErrors[].
         The OS is absent from latestVersionsByOs.

4. Apply osTypeOverrides on top (caller wins for any OS they pin).

5. Call the engine via:
     EngineClient.analyze("oneagent.distribution", { hosts, latestVersionsByOs })

   The engine returns the typed summary. See distribution.md for shape.

6. Assemble response:
     { summary }
     + latestLookupErrors (if any failed)
     + hosts (only if includeHosts:true)

7. Return as MCP text content.
```

---

## HTTP endpoints touched

| Endpoint | Method | Purpose | Failure mode |
|---|---|---|---|
| `/api/v2/oneagents` | GET | Host inventory (paginated) | Aborts the tool with an error if it fails — there's no fallback for the primary inventory. |
| `/api/v1/deployment/installer/agent/{os}/default/latest/metainfo` | GET | Per-OS latest version (primary) | Falls back to v2 listing if 4xx/5xx. |
| `/api/v1/deployment/installer/agent/versions/{os}` | GET | Per-OS available versions (fallback). Last element treated as latest. | Records the OS in `latestLookupErrors` and proceeds without a latest for that OS. |

### Why two endpoints for latest?

Dynatrace Managed varies by cluster version. Some clusters expose the cleaner `/metainfo` endpoint with a direct `latestAgentVersion` field; older builds only have `/versions/{os}` returning a list. We try the cleaner one first.

### Why pass `osType` as lowercase in the URL?

The deployment installer endpoints expect lowercase OS identifiers (`linux`, `windows`, `aix_ppc`). The host inventory returns them uppercase (`LINUX`, `WINDOWS_DESKTOP`). The tool lowercases before the URL fetch.

The map keys we send to the engine stay uppercase — they have to match `host.hostInfo.osType` for the analyzer to find them.

---

## Pagination semantics

| Property | Value |
|---|---|
| Initial pageSize | 500 |
| Max pages | 200 (cap) |
| Cap behavior | Stops paginating, uses what we have. The MCP doesn't surface the "we hit the cap" condition explicitly — the totalCount in the engine summary will reflect the partial set. |
| `nextPageKey` shape | String. When the page returns a non-null nextPageKey, we pass it as the only query param on the next request (per Dynatrace v2 convention — nextPageKey supersedes all other params). |

The 200-page cap exists to prevent runaway requests on misbehaving endpoints. At pageSize=500 that's 100,000 hosts — well above any real Managed deployment.

---

## Error handling

| Failure | Behavior |
|---|---|
| `/api/v2/oneagents` fails on first page | Tool errors with a clear message; nothing else attempted. |
| `/api/v2/oneagents` fails mid-pagination | Tool errors. We don't return a partial result. |
| One OS's latest lookup fails (both endpoints) | OS recorded in `latestLookupErrors`, tool continues. The engine handles the missing OS via `hostsWithoutOsLatestReference`. |
| Engine subprocess can't be spawned | Tool returns `{ available: false }` with isError:true and a setup hint. |
| Engine analyzer rejects input shape | Bubbles up as a tool error with the engine's error message. Shouldn't happen because the TS wrapper is typed against the analyzer's input shape, but defends against the case where shapes drift. |

---

## What's NOT in this tool

- Any version comparison logic — that's in the engine.
- Any "is this host outdated" classification — engine.
- Any "behind latest" math — engine.
- Any sorting of the response — engine emits in a deterministic order (per-MT lists sorted by entityId); the tool passes through. Consumers wanting different sort orders sort on their end.
- Any caching of the latest-version lookup — every call refetches. We could add caching with a TTL later if it becomes a latency concern; today's load is modest.

---

## Examples

### Default call

```ts
dt_get_oneagent_versions({})
```

Fetches everything, looks up latest per OS, returns just the summary.

### Skip the latest lookup (faster, less informative)

```ts
dt_get_oneagent_versions({ skipLatestLookup: true })
```

Skips step 3. Every versioned host ends up in `hostsWithoutOsLatestReference`. `outdatedHostsCount` will be 0 because we have no reference to compare against.

### Pin a specific latest for testing

```ts
dt_get_oneagent_versions({ osTypeOverrides: { "LINUX": "1.300.0" } })
```

Still does the cluster lookup, but `LINUX` gets pinned to `1.300.0` regardless. Useful when the cluster's reported latest is wrong (e.g. canary build temporarily marked latest) or when you want to test "what if the latest were X".

### Return the full host inventory too

```ts
dt_get_oneagent_versions({ includeHosts: true })
```

Same summary, plus the full raw paginated host list. Response can be very large on big tenants — don't use this unless you actually need the per-host raw data.

---

## Related

- Engine analyzer: [`oneagent.distribution`](../../../dt-managed-engine/internal/analyze/oneagent/distribution.md)
- TS wrapper: `src/engine/analyzers/oneagent-distribution.ts`
- Engine subprocess: managed by `src/engine/engine-singleton.ts`
- Future: a check `CHECK_ONEAGENT_BEHIND_LATEST` should be added on the engine side that consumes the same data and produces Findings rather than raw counts (gives us severity + recommendation per outdated host).
