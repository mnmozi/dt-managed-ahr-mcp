#!/usr/bin/env bash
# List Dynatrace process groups with their process group instances and the
# exec command each instance runs (EXE_PATH + COMMAND_LINE_ARGS from entity
# metadata, falling back to EXE_NAME / JAVA_JAR_FILE).
#
# Standalone: needs only bash, curl, jq. Read-only (entities.read scope).
#
# Usage:
#   DT_CLUSTER_URL="https://cluster:8080" DT_ENV_ID="<env-id>" DT_TOKEN="<token>" \
#   [DT_TLS_VERIFY=0] ./list-pg-exec.sh [pg-name-filter] [--json] [--by-pattern]
#
#   pg-name-filter   optional case-insensitive substring on the PG name
#   --json           emit JSON instead of text
#   --by-pattern     group by normalized exec pattern (digit runs -> <n>,
#                    id-like tokens -> <id>) so replicas collapse; sorted by
#                    instance count
set -euo pipefail

: "${DT_CLUSTER_URL:?set DT_CLUSTER_URL, e.g. https://cluster:8080}"
: "${DT_ENV_ID:?set DT_ENV_ID (environment UUID)}"
: "${DT_TOKEN:?set DT_TOKEN (API token with entities.read scope)}"
command -v jq >/dev/null || { echo "jq is required (apt/yum/brew install jq)" >&2; exit 1; }

AS_JSON=0; BY_PATTERN=0; FILTER=""
for arg in "$@"; do
  case "$arg" in
    --json) AS_JSON=1 ;;
    --by-pattern) BY_PATTERN=1 ;;
    --*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) FILTER="$arg" ;;
  esac
done

CURL_OPTS=(-sS --fail -H "Authorization: Api-Token ${DT_TOKEN}")
[[ "${DT_TLS_VERIFY:-1}" == "0" ]] && CURL_OPTS+=(-k)
BASE="${DT_CLUSTER_URL%/}/e/${DT_ENV_ID}/api/v2/entities"

# Paginate one entity type into a JSON array on stdout.
fetch_all() { # $1=entity type  $2=fields
  local next="" page=0 out="[]" resp
  while :; do
    if [[ -z "$next" ]]; then
      resp=$(curl "${CURL_OPTS[@]}" -G "$BASE" \
        --data-urlencode "entitySelector=type($1)" \
        --data-urlencode "fields=$2" \
        --data-urlencode "from=now-24h" \
        --data-urlencode "to=now" \
        --data-urlencode "pageSize=500")
    else
      resp=$(curl "${CURL_OPTS[@]}" -G "$BASE" --data-urlencode "nextPageKey=$next")
    fi
    out=$(jq -c --argjson acc "$out" '$acc + (.entities // [])' <<<"$resp")
    next=$(jq -r '.nextPageKey // empty' <<<"$resp")
    page=$((page + 1))
    [[ -z "$next" || $page -ge 100 ]] && break
  done
  printf '%s' "$out"
}

PGS=$(fetch_all "PROCESS_GROUP" "+fromRelationships")
PGIS=$(fetch_all "PROCESS_GROUP_INSTANCE" "+properties,+fromRelationships")

jq -n -r \
  --argjson pgs "$PGS" \
  --argjson pgis "$PGIS" \
  --arg filter "$FILTER" \
  --argjson asJson "$AS_JSON" \
  --argjson byPattern "$BY_PATTERN" '
def meta($k): ((.properties.metadata // []) | map(select(.key == $k)) | first | .value?) // null;
def execmd:
  (meta("EXE_PATH") // meta("EXE_NAME")) as $exe
  | meta("COMMAND_LINE_ARGS") as $args
  | meta("JAVA_JAR_FILE") as $jar
  | if $exe != null and $args != null then "\($exe) \($args)"
    elif $exe != null then $exe
    elif $jar != null then "(jar) \($jar)"
    else "(no exec metadata)" end;
def parentpg:
  [.fromRelationships // {} | to_entries[] | .value[]?
   | select(.type == "PROCESS_GROUP") | .id] | first;
# Same spirit as the TS version: id-like tokens (letters + >=2 digits) -> <id>,
# pure digit runs -> <n>. Replicas and same-shaped workloads collapse.
def pattern:
  gsub("\\b(?=[A-Za-z0-9]*[0-9][A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,}\\b"; "<id>")
  | gsub("\\b[0-9]+\\b"; "<n>");

($pgs | map(select(.entityId != null)
  | {key: .entityId, value: (.displayName // "(unnamed)")}) | from_entries) as $pgname
| ($pgis | map({
    pgId: parentpg,
    name: (.displayName // "(unnamed)"),
    pgiId: .entityId,
    exec: execmd
  })) as $insts
| ($insts | map(select(.pgId == null)) | length) as $orphans
| ($pgname | to_entries
    | map(select(($filter == "") or ((.value | ascii_downcase) | contains($filter | ascii_downcase))))
    | sort_by(.value)
    | map({
        processGroup: .value,
        pgId: .key,
        instances: (.key as $id | $insts | map(select(.pgId == $id)) | map({name, pgiId, exec}))
      })) as $rows
| if $byPattern == 1 then
    ($rows | map(.processGroup as $pg | .instances[] | {pattern: (.exec | pattern), pg: $pg, exec})
      | group_by(.pattern)
      | map({
          pattern: .[0].pattern,
          instances: length,
          processGroups: (group_by(.pg) | map({key: .[0].pg, value: length}) | from_entries),
          exampleExec: .[0].exec
        })
      | sort_by(-.instances, .pattern)) as $pats
    | if $asJson == 1 then {patterns: $pats, orphanInstances: $orphans}
      else
        ($pats | map(
          "\n[\(.instances) instance\(if .instances == 1 then "" else "s" end) / \(.processGroups | length) PG\(if (.processGroups | length) == 1 then "" else "s" end)]  \(.pattern)"
          + (.processGroups | to_entries | sort_by(-.value) | map("\n    \(.key) (\(.value))") | join(""))
          + (if .exampleExec != .pattern then "\n    e.g. \(.exampleExec)" else "" end)
        ) | join(""))
        + "\n\n\($pats | length) distinct exec patterns across \($rows | length) process groups"
        + (if $filter != "" then " (filter: \"\($filter)\")" else "" end)
      end
  elif $asJson == 1 then {processGroups: $rows, orphanInstances: $orphans}
  else
    ($rows | map(
      "\n\(.processGroup)  [\(.pgId)]"
      + (if (.instances | length) == 0 then "\n    (no instances seen in the last 24h)"
         else (.instances | map("\n    \(.name)  [\(.pgiId)]\n        exec: \(.exec)") | join(""))
         end)
    ) | join(""))
    + "\n\n\($rows | length) process groups, \($insts | length) instances"
    + (if $orphans > 0 then ", \($orphans) instances without a resolvable PG" else "" end)
    + (if $filter != "" then " (filter: \"\($filter)\")" else "" end)
  end
| if type == "string" then . else tojson end'
