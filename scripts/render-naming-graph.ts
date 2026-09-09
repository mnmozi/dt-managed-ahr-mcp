#!/usr/bin/env tsx
/**
 * Render the entity graph + naming suggestions as a self-contained HTML
 * file. Read-only against the cluster; spawns its own engine subprocess.
 *
 * Usage:
 *   DT_CLUSTER_URL=... DT_ENV_ID=... DT_TOKEN=... DT_TLS_VERIFY=0 \
 *   DT_ENGINE_BIN=/abs/path/dt-engine \
 *   npm run graph:naming [-- /output/path.html]
 *
 * Layout: four columns (HOST | PROCESS GROUP | PGI | SERVICE) with
 * containment / backing edges. Entities flagged by the naming audits are
 * color-coded by decision bucket and show "current → suggested". Hover
 * any flagged node for the full candidate list with evidence.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { DtClient } from "../src/dt-client.js";
import { getEngine, stopEngine } from "../src/engine/engine-singleton.js";
import { fetchNamingGraph } from "../src/engine/naming-graph-fetcher.js";
import {
  analyzeProcessGroupNaming,
  type EntityNamingReport,
} from "../src/engine/analyzers/processgroups-naming-audit.js";
import { analyzeHostNaming } from "../src/engine/analyzers/hosts-naming-audit.js";
import { analyzeServiceNaming } from "../src/engine/analyzers/services-naming-audit.js";

interface GNode {
  id: string;
  type: "HOST" | "PG" | "PGI" | "SERVICE";
  name: string;
  decision?: string;
  topCandidate?: string;
  genericReason?: string;
  candidates?: Array<{ source: string; name: string; confidence: number; evidence: string }>;
  corroborating?: Array<{ source: string; name: string; confidence: number; evidence: string }>;
  rejected?: Array<{ source: string; name: string; confidence: number; evidence: string; reason: string }>;
  endpoints?: string[];
}

interface GEdge {
  from: string;
  to: string;
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? "naming-graph.html");
  const cfg = loadConfig();
  const client = new DtClient(cfg);

  console.log(`[graph] fetching entity graph from ${cfg.clusterUrl} ...`);
  const graph = await fetchNamingGraph(client);
  console.log(
    `[graph] hosts=${graph.hosts.length} pgs=${graph.processGroups.length} pgis=${graph.processGroupInstances.length} services=${graph.services.length}`
  );

  console.log("[graph] running naming audits ...");
  const engine = await getEngine();
  const [pgAudit, hostAudit, svcAudit] = [
    await analyzeProcessGroupNaming(engine, { ...graph, explain: true, auditAll: true }),
    await analyzeHostNaming(engine, { ...graph, explain: true, auditAll: true }),
    await analyzeServiceNaming(engine, { ...graph, explain: true, auditAll: true }),
  ];
  await stopEngine();
  await client.close();

  const reportByEntity = new Map<string, EntityNamingReport>();
  for (const r of [...pgAudit.reports, ...hostAudit.reports, ...svcAudit.reports]) {
    reportByEntity.set(r.entityId, r);
  }

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const attach = (id: string, type: GNode["type"], name: string, endpoints?: string[]): void => {
    const rep = reportByEntity.get(id);
    nodes.push({
      id,
      type,
      name: name || id,
      decision: rep?.decision,
      topCandidate: rep?.topCandidate,
      genericReason: rep?.genericReason || undefined,
      candidates: rep?.candidates ?? undefined,
      corroborating: rep?.corroborating,
      rejected: rep?.rejectedCandidates,
      endpoints: endpoints && endpoints.length > 0 ? endpoints.slice(0, 10) : undefined,
    });
  };

  for (const h of graph.hosts) attach(h.id, "HOST", h.displayName ?? h.id);
  for (const pg of graph.processGroups) {
    attach(pg.id, "PG", pg.displayName ?? pg.id);
    if (pg.hostId) edges.push({ from: pg.id, to: pg.hostId });
  }
  for (const pgi of graph.processGroupInstances) {
    attach(pgi.id, "PGI", pgi.displayName ?? pgi.id);
    if (pgi.pgId) edges.push({ from: pgi.id, to: pgi.pgId });
    for (const svcId of pgi.serviceIds ?? []) edges.push({ from: svcId, to: pgi.id });
  }
  for (const svc of graph.services) attach(svc.id, "SERVICE", svc.displayName ?? svc.id, svc.endpoints);

  const meta = {
    cluster: cfg.clusterUrl,
    generatedAt: new Date().toISOString(),
    counts: {
      hosts: graph.hosts.length,
      pgs: graph.processGroups.length,
      pgis: graph.processGroupInstances.length,
      services: graph.services.length,
      flagged: [...reportByEntity.values()].filter((r) => r.genericReason).length,
      advisory: [...reportByEntity.values()].filter((r) => !r.genericReason && r.topCandidate).length,
      highConfidence: pgAudit.counts.highConfidence + hostAudit.counts.highConfidence + svcAudit.counts.highConfidence,
      ambiguous: pgAudit.counts.ambiguous + hostAudit.counts.ambiguous + svcAudit.counts.ambiguous,
      noSignal: pgAudit.counts.noSignal + hostAudit.counts.noSignal + svcAudit.counts.noSignal,
    },
  };

  const payload = JSON.stringify({ nodes, edges, meta }).replace(/<\//g, "<\\/");
  writeFileSync(outPath, htmlTemplate(payload), "utf8");
  console.log(`[graph] wrote ${outPath}`);
  console.log(
    `[graph] flagged=${meta.counts.flagged} (high=${meta.counts.highConfidence} ambiguous=${meta.counts.ambiguous} no_signal=${meta.counts.noSignal}) advisory=${meta.counts.advisory}`
  );
}

function htmlTemplate(payloadJSON: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Naming Graph</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --text: #d7dae2; --dim: #8a90a2;
    --host: #3d5a80; --pg: #5a4a7d; --pgi: #46426b; --svc: #2e6e5e;
    --high: #34d399; --ambig: #fbbf24; --nosig: #6b7280; --edge: #2c3040;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
  header { padding: 14px 20px; border-bottom: 1px solid #23283a; display: flex; flex-wrap: wrap; gap: 16px; align-items: center; position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 15px; font-weight: 600; }
  header .meta { color: var(--dim); font-size: 11px; }
  .legend { display: flex; gap: 12px; font-size: 11px; align-items: center; }
  .chip { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
  .controls { display: flex; gap: 10px; align-items: center; margin-left: auto; }
  .controls label { font-size: 11px; color: var(--dim); cursor: pointer; user-select: none; }
  .controls input[type="text"] { background: var(--panel); color: var(--text); border: 1px solid #2c3040; border-radius: 6px; padding: 4px 8px; font: inherit; width: 180px; }
  #wrap { overflow: auto; }
  svg { display: block; }
  .colhdr { fill: var(--dim); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; }
  .edge { stroke: var(--edge); stroke-width: 1; fill: none; }
  .edge.hot { stroke: #4f8cff; stroke-width: 1.6; }
  .node rect { rx: 6; }
  .node text { fill: var(--text); font-size: 11px; pointer-events: none; }
  .node .sub { fill: var(--dim); font-size: 10px; }
  .node .sugg { font-weight: 700; }
  .node.high .sugg { fill: var(--high); }
  .node.ambiguous .sugg { fill: var(--ambig); }
  .node.no_signal .sub { fill: var(--nosig); }
  .node .alt { fill: #4f8cff; font-weight: 600; }
  .node.dim { opacity: 0.18; }
  #tip { position: fixed; display: none; max-width: 520px; background: var(--panel); border: 1px solid #2c3040; border-radius: 8px; padding: 10px 12px; font-size: 11px; z-index: 10; pointer-events: none; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #tip.locked { pointer-events: auto; max-height: 62vh; overflow: auto; border-color: #4f8cff; }
  #tip .hint { color: var(--dim); margin-top: 8px; font-size: 10px; }
  .node.locked rect { stroke: #4f8cff !important; stroke-width: 2.6; }
  .node { cursor: default; }
  .nbtn { cursor: pointer; }
  .nbtn rect { fill: #1d2b45; stroke: #35507f; rx: 4; }
  .nbtn:hover rect { fill: #24365a; }
  .nbtn text { fill: #9cc0ff; font-size: 10px; pointer-events: none; }
  .nbtn.active rect { fill: #12351f; stroke: #1f5c37; }
  .nbtn.active text { fill: var(--high); }
  #tip h3 { font-size: 12px; margin-bottom: 6px; }
  #tip .reason { color: var(--ambig); margin-bottom: 6px; }
  #tip table { border-collapse: collapse; width: 100%; }
  #tip td { padding: 2px 8px 2px 0; vertical-align: top; color: var(--dim); }
  #tip td:first-child { color: var(--text); white-space: nowrap; }
  #tip .conf { color: var(--high); }
  #tip .ep { color: var(--dim); }
  #tip button.add { background: #1d2b45; color: #9cc0ff; border: 1px solid #35507f; border-radius: 5px; font: 10px ui-monospace, monospace; padding: 2px 7px; cursor: pointer; white-space: nowrap; }
  #tip button.add:hover { background: #24365a; }
  #tip button.add.added { background: #12351f; color: var(--high); border-color: #1f5c37; }
  #tip .how { margin-top: 8px; border-top: 1px solid #23283a; padding-top: 6px; }
  #tip .how h4 { font-size: 10px; color: #9cc0ff; margin-bottom: 3px; letter-spacing: .05em; }
  #tip .how ol { margin: 0 0 0 16px; color: var(--dim); }
  #tip .how li { margin-bottom: 2px; }
  #tip .how b { color: var(--text); }
  #tip .custom { margin-top: 8px; display: flex; gap: 6px; }
  #tip .custom input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid #2c3040; border-radius: 5px; padding: 3px 7px; font: 10px ui-monospace, monospace; }
  #cart { position: fixed; right: 16px; bottom: 16px; width: 340px; background: var(--panel); border: 1px solid #35507f; border-radius: 10px; padding: 12px; z-index: 20; box-shadow: 0 10px 40px rgba(0,0,0,.6); font-size: 11px; display: none; }
  #cart h2 { font-size: 12px; margin-bottom: 8px; }
  #cart ul { list-style: none; max-height: 30vh; overflow: auto; margin-bottom: 8px; }
  #cart li { display: flex; gap: 6px; align-items: center; padding: 3px 0; border-bottom: 1px solid #23283a; }
  #cart li .who { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cart li .to { color: var(--high); font-weight: 600; }
  #cart li button { background: none; border: none; color: var(--nosig); cursor: pointer; font-size: 12px; }
  #cart .actions { display: flex; gap: 8px; }
  #cart .actions button { flex: 1; background: #1d2b45; color: #9cc0ff; border: 1px solid #35507f; border-radius: 6px; padding: 6px; font: 11px ui-monospace, monospace; cursor: pointer; }
  #cart .actions button.primary { background: #12351f; color: var(--high); border-color: #1f5c37; }
  #export { position: fixed; inset: 5vh 8vw; background: var(--panel); border: 1px solid #35507f; border-radius: 12px; z-index: 30; display: none; flex-direction: column; padding: 18px; box-shadow: 0 20px 80px rgba(0,0,0,.7); }
  #export h2 { font-size: 14px; margin-bottom: 4px; }
  #export .note { color: var(--dim); font-size: 11px; margin-bottom: 10px; }
  #export .tools { overflow: auto; flex: 1; }
  #export .toolblock { margin-bottom: 14px; }
  #export .toolblock h3 { font-size: 12px; color: #9cc0ff; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; }
  #export textarea { width: 100%; height: 160px; background: var(--bg); color: var(--text); border: 1px solid #2c3040; border-radius: 8px; font: 10px ui-monospace, monospace; padding: 8px; }
  #export .close { position: absolute; top: 10px; right: 14px; background: none; border: none; color: var(--dim); font-size: 18px; cursor: pointer; }
  #export button.copy { background: #1d2b45; color: #9cc0ff; border: 1px solid #35507f; border-radius: 5px; font: 10px ui-monospace, monospace; padding: 2px 8px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>Naming Graph</h1>
  <span class="meta" id="meta"></span>
  <div class="legend">
    <span><span class="chip" style="background:var(--high)"></span>high_confidence</span>
    <span><span class="chip" style="background:var(--ambig)"></span>ambiguous</span>
    <span><span class="chip" style="background:var(--nosig)"></span>no_signal</span>
    <span><span class="chip" style="background:#4f8cff"></span>advisory (not flagged)</span>
  </div>
  <div class="controls">
    <label><input type="checkbox" id="onlyFlagged"> only flagged</label>
    <label><input type="checkbox" id="showPGIs" checked> show PGIs</label>
    <input type="text" id="search" placeholder="filter by name...">
  </div>
</header>
<div id="wrap"></div>
<div id="tip"></div>
<div id="cart">
  <h2>Rename decisions <span id="cartCount" style="color:var(--dim)"></span></h2>
  <ul id="cartList"></ul>
  <div class="actions">
    <button id="cartClear">clear</button>
    <button id="cartExport" class="primary">Export MCP calls</button>
  </div>
</div>
<div id="export">
  <button class="close" id="exportClose">✕</button>
  <h2>Apply these renames via your MCP client</h2>
  <div class="note">Three ways to solve each rename, ordered by increasing permanence: <b>1)</b> clarifying tag — safe, reversible, executable right now via the generated MCP call; <b>2)</b> conditional-naming rule — the real display-name rename, keyed on the tag from step 1 (generated as dt_raw_post templates); <b>3)</b> fix at source — change what Dynatrace detects. Paste any JSON block into your MCP client ("call &lt;tool&gt; with this input").</div>
  <div class="tools" id="exportTools"></div>
</div>
<script>
const DATA = ${payloadJSON};
const COLS = [
  { key: "HOST", label: "HOSTS", x: 40 },
  { key: "PG", label: "PROCESS GROUPS", x: 460 },
  { key: "PGI", label: "INSTANCES", x: 880 },
  { key: "SERVICE", label: "SERVICES", x: 1300 },
];
const NODE_W = 360, NODE_H = 40, GAP = 10, TOP = 56;

const meta = DATA.meta;
document.getElementById("meta").textContent =
  meta.cluster + "  ·  " + meta.generatedAt + "  ·  " +
  meta.counts.hosts + " hosts / " + meta.counts.pgs + " PGs / " +
  meta.counts.pgis + " PGIs / " + meta.counts.services + " services  ·  flagged: " +
  meta.counts.flagged;

const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const adj = new Map();  // id -> Set(neighbor ids)
for (const e of DATA.edges) {
  if (!adj.has(e.from)) adj.set(e.from, new Set());
  if (!adj.has(e.to)) adj.set(e.to, new Set());
  adj.get(e.from).add(e.to);
  adj.get(e.to).add(e.from);
}

const state = { onlyFlagged: false, showPGIs: true, search: "", locked: null, lockedMode: null };
const cart = new Map(); // entityId -> {chosenName, source}

const TOOL_BY_TYPE = {
  PG: "dt_apply_pg_naming_rule",
  SERVICE: "dt_apply_service_clarifying_tag",
  HOST: "dt_apply_host_clarifying_tag",
};
const ENTITYTYPE_BY_TYPE = { PG: "PROCESS_GROUP", SERVICE: "SERVICE", HOST: "HOST" };
const NAMING_RULE_META = {
  PG:      { path: "/api/config/v1/conditionalNaming/processGroup", ruleType: "PROCESS_GROUP", tagAttr: "PROCESS_GROUP_TAGS" },
  SERVICE: { path: "/api/config/v1/conditionalNaming/service",      ruleType: "SERVICE",       tagAttr: "SERVICE_TAGS" },
  HOST:    { path: "/api/config/v1/conditionalNaming/host",         ruleType: "HOST",          tagAttr: "HOST_TAGS" },
};
const AT_SOURCE_HINTS = {
  PG: "K8s: name the container/workload properly. VM: pass --name= in argv or set DT_TAGS. Structural: a PG advanced-detection rule (builtin:process-group.advanced-detection-rule) can regroup/rename at detection time.",
  SERVICE: "Deploy the webapp with a real context root (Tomcat), set OTel service.name resource attribute, or configure the web-server virtual host — Dynatrace re-detects the service name from these.",
  HOST: "Set the OS hostname, use oneagentctl --set-host-name, or add an AWS 'Name' tag (surfaces when the AWS integration is connected).",
};
function namingRuleCall(type, chosenName) {
  const m = NAMING_RULE_META[type];
  return {
    tool: "dt_raw_post",
    input: {
      path: m.path,
      body: {
        // Shape validated against live rules on Managed 1.342: rules[] is a
        // FLAT condition array; keys carry type STATIC.
        type: m.ruleType,
        enabled: true,
        displayName: "naming: " + chosenName + " (via name tag)",
        nameFormat: chosenName,
        rules: [{
          key: { attribute: m.tagAttr, type: "STATIC" },
          comparisonInfo: {
            type: "TAG", operator: "EQUALS", negate: false,
            value: { context: "CONTEXTLESS", key: "name", value: chosenName },
          },
        }],
      },
      confirm: "yes",
    },
  };
}

function cartAdd(id, chosenName, source) {
  cart.set(id, { chosenName, source });
  renderCart();
}
function cartRemove(id) { cart.delete(id); renderCart(); }
function renderCart() {
  const el = document.getElementById("cart");
  el.style.display = cart.size ? "block" : "none";
  document.getElementById("cartCount").textContent = "(" + cart.size + ")";
  document.getElementById("cartList").innerHTML = [...cart.entries()].map(([id, d]) => {
    const n = byId.get(id);
    return '<li><span class="who">' + esc(n.type + " " + trunc(n.name, 26)) + '</span>→ <span class="to">' +
      esc(d.chosenName) + '</span><button data-uncart="' + esc(id) + '">✕</button></li>';
  }).join("");
}
function reportForExport(n) {
  return {
    entityId: n.id,
    entityType: ENTITYTYPE_BY_TYPE[n.type],
    currentName: n.name,
    genericReason: n.genericReason ?? "",
    candidates: n.candidates ?? [],
    ...(n.topCandidate ? { topCandidate: n.topCandidate } : {}),
    decision: n.decision,
  };
}
function buildExport() {
  const groups = {};
  for (const [id, d] of cart.entries()) {
    const n = byId.get(id);
    const tool = TOOL_BY_TYPE[n.type];
    if (!tool) continue;
    groups[tool] = groups[tool] || { reports: [], decisions: [], confirm: "yes" };
    groups[tool].reports.push(reportForExport(n));
    groups[tool].decisions.push({ entityId: id, chosenName: d.chosenName, source: d.source });
  }
  return groups;
}
document.getElementById("cartClear").addEventListener("click", () => { cart.clear(); renderCart(); });
document.getElementById("cartExport").addEventListener("click", () => {
  const groups = buildExport();
  const wrap = document.getElementById("exportTools");
  let idx = 0;
  const blocks = [];
  for (const [tool, payload] of Object.entries(groups)) {
    const type = Object.keys(TOOL_BY_TYPE).find(t => TOOL_BY_TYPE[t] === tool);
    const names = [...new Set(payload.decisions.map(d => d.chosenName))];
    const ruleCalls = names.map(nm => namingRuleCall(type, nm));
    const i1 = idx++, i2 = idx++;
    blocks.push(
      '<div class="toolblock">' +
      '<h3>' + ENTITYTYPE_BY_TYPE[type] + " — " + payload.decisions.length + " rename(s)</h3>" +

      '<h3 style="color:var(--high)">Method 1 · clarifying tag (do this now) <button class="copy" data-copy="' + i1 + '">copy JSON</button></h3>' +
      '<div class="note">One MCP call: <b>' + tool + '</b>. Writes a reversible name:&lt;value&gt; tag per entity — audited + lattice-validated. Display name unchanged; rules/queries can match tag(name:value) immediately.</div>' +
      '<textarea readonly id="exp-' + i1 + '">' + esc(JSON.stringify(payload, null, 2)) + "</textarea>" +

      '<h3 style="color:#9cc0ff">Method 2 · naming rule (actual display-name rename) <button class="copy" data-copy="' + i2 + '">copy JSON</button></h3>' +
      '<div class="note">Run AFTER Method 1. One <b>dt_raw_post</b> per distinct name → Config v1 conditional-naming rule keyed on the name tag; the UI display name becomes the chosen name for every entity carrying it. Validated live on Managed 1.341. SHORTCUT: add \"createNamingRule\": true to the Method-1 call and both steps run in one tool call (existing rules are deduped by nameFormat).</div>' +
      '<textarea readonly id="exp-' + i2 + '">' + esc(JSON.stringify(ruleCalls, null, 2)) + "</textarea>" +

      '<h3 style="color:var(--dim)">Method 3 · fix at source (permanent, no Dynatrace config)</h3>' +
      '<div class="note">' + esc(AT_SOURCE_HINTS[type]) + "</div>" +
      "</div>"
    );
  }
  wrap.innerHTML = blocks.join("") || '<div class="note">cart is empty</div>';
  document.getElementById("export").style.display = "flex";
});
document.getElementById("exportClose").addEventListener("click", () => {
  document.getElementById("export").style.display = "none";
});
document.getElementById("exportTools").addEventListener("click", ev => {
  const b = ev.target.closest("button.copy");
  if (!b) return;
  const ta = document.getElementById("exp-" + b.dataset.copy);
  navigator.clipboard.writeText(ta.value).then(() => { b.textContent = "copied ✓"; setTimeout(() => b.textContent = "copy JSON", 1500); });
});
document.getElementById("cartList").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-uncart]");
  if (b) cartRemove(b.dataset.uncart);
});

function visible(n) {
  if (!state.showPGIs && n.type === "PGI") return false;
  if (state.onlyFlagged) {
    const nearFlag = n.genericReason || [...(adj.get(n.id) ?? [])].some(o => byId.get(o)?.genericReason);
    if (!nearFlag) return false;
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    const hit = n.name.toLowerCase().includes(q) || (n.topCandidate ?? "").toLowerCase().includes(q);
    const nearHit = [...(adj.get(n.id) ?? [])].some(o => {
      const m = byId.get(o);
      return m && (m.name.toLowerCase().includes(q) || (m.topCandidate ?? "").toLowerCase().includes(q));
    });
    if (!hit && !nearHit) return false;
  }
  return true;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function render() {
  // Filters rebuild the SVG — any locked node may vanish, so release.
  state.locked = null;
  const tipEl = document.getElementById("tip");
  tipEl.style.display = "none";
  tipEl.classList.remove("locked");
  const shown = DATA.nodes.filter(visible);
  const pos = new Map();
  const colY = {};
  for (const c of COLS) colY[c.key] = TOP;

  // Order: hosts first; PGs grouped under their host; PGIs under their PG;
  // services after their first backing PGI. Simple two-pass: place HOST +
  // PG + PGI by column order of appearance, then SERVICE near mean of
  // its backing PGIs.
  for (const n of shown) {
    if (n.type === "SERVICE") continue;
    const col = COLS.find(c => c.key === n.type);
    pos.set(n.id, { x: col.x, y: colY[n.type] });
    colY[n.type] += NODE_H + GAP;
  }
  const svcCol = COLS.find(c => c.key === "SERVICE");
  const svcs = shown.filter(n => n.type === "SERVICE");
  const desired = svcs.map(n => {
    const ys = [...(adj.get(n.id) ?? [])].map(o => pos.get(o)?.y).filter(y => y !== undefined);
    return { n, want: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 1e9 };
  }).sort((a, b) => a.want - b.want);
  for (const d of desired) {
    const y = Math.max(colY.SERVICE, d.want === 1e9 ? colY.SERVICE : d.want);
    pos.set(d.n.id, { x: svcCol.x, y });
    colY.SERVICE = y + NODE_H + GAP;
  }

  const height = Math.max(...Object.values(colY)) + 40;
  const width = svcCol.x + NODE_W + 60;

  let out = "";
  for (const c of COLS) {
    if (c.key === "PGI" && !state.showPGIs) continue;
    out += '<text class="colhdr" x="' + c.x + '" y="' + (TOP - 16) + '">' + c.label + "</text>";
  }
  for (const e of DATA.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x <= b.x ? a.x + NODE_W : a.x, x2 = a.x <= b.x ? b.x : b.x + NODE_W;
    const y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    out += '<path class="edge" data-from="' + e.from + '" data-to="' + e.to +
      '" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + x2 + " " + y2 + '"/>';
  }
  const typeFill = { HOST: "var(--host)", PG: "var(--pg)", PGI: "var(--pgi)", SERVICE: "var(--svc)" };
  const bucketCls = { high_confidence: "high", ambiguous: "ambiguous", no_signal: "no_signal" };
  for (const n of shown) {
    const p = pos.get(n.id);
    if (!p) continue;
    const flagged = Boolean(n.genericReason);
    const advisory = !flagged && Boolean(n.topCandidate);
    const cls = "node " + (flagged ? (bucketCls[n.decision] ?? "") : advisory ? "advisory" : "");
    const stroke = !flagged ? (advisory ? "#4f8cff66" : "transparent")
      : n.decision === "high_confidence" ? "var(--high)"
      : n.decision === "ambiguous" ? "var(--ambig)"
      : "var(--nosig)";
    const dash = flagged && n.decision === "no_signal" ? ' stroke-dasharray="4 3"' : "";
    out += '<g class="' + cls + '" data-id="' + n.id + '" transform="translate(' + p.x + "," + p.y + ')">';
    out += '<rect width="' + NODE_W + '" height="' + NODE_H + '" fill="' + typeFill[n.type] +
      '" fill-opacity="0.28" stroke="' + stroke + '" stroke-width="1.6"' + dash + "/>";
    out += '<text x="10" y="17">' + esc(trunc(n.name, 46)) + "</text>";
    if (flagged && n.topCandidate) {
      out += '<text class="sub" x="10" y="32">→ <tspan class="sugg">' + esc(n.topCandidate) +
        "</tspan> (" + n.decision + ")</text>";
    } else if (flagged) {
      out += '<text class="sub" x="10" y="32">' + n.decision + " — manual review</text>";
    } else if (advisory) {
      out += '<text class="sub" x="10" y="32">alt: <tspan class="alt">' + esc(n.topCandidate) + "</tspan></text>";
    } else if (n.corroborating?.length) {
      out += '<text class="sub" x="10" y="32">✓ name corroborated (' + n.corroborating.length + ")</text>";
    }
    // Two per-node buttons: ⌖ locks just the path highlight; ⓘ pins details.
    const pActive = state.locked === n.id && state.lockedMode === "path" ? " active" : "";
    out += '<g class="nbtn path' + pActive + '" data-btn="path" data-id="' + esc(n.id) + '" transform="translate(' + (NODE_W - 46) + ',6)">' +
      '<rect width="18" height="14"/><text x="4" y="11">⌖</text></g>';
    out += '<g class="nbtn info" data-btn="info" data-id="' + esc(n.id) + '" transform="translate(' + (NODE_W - 24) + ',6)">' +
      '<rect width="18" height="14"/><text x="5" y="11">ⓘ</text></g>';
    out += "</g>";
  }
  document.getElementById("wrap").innerHTML =
    '<svg width="' + width + '" height="' + height + '">' + out + "</svg>";
  wire();
}

function tipHTML(n, locked) {
  let html = "<h3>" + esc(n.name) + " <span style='color:var(--dim)'>(" + n.type + ")</span></h3>";
  if (n.genericReason) html += '<div class="reason">flagged: ' + esc(n.genericReason) + "</div>";
  if (!n.genericReason) {
    // Not flagged — say WHY, so every entity has a written reason.
    html += '<div style="color:var(--dim)">' + (
      n.type === "PGI"
        ? "not audited — process group instances inherit their PG's name"
        : n.decision
          ? "name not flagged as generic. Anything below is ADVISORY — evidence-based alternatives the operator may ignore."
          : "audited, not flagged: display name matched no generic pattern (it identifies the workload)"
    ) + "</div>";
  }
  if (n.candidates?.length) {
    const renameable = Boolean(TOOL_BY_TYPE[n.type]);
    html += "<table>" + n.candidates.map(c =>
      "<tr><td>" + esc(c.name) + '</td><td class="conf">' + c.confidence.toFixed(2) +
      "</td><td>" + esc(c.source) + "</td><td>" + esc(locked ? c.evidence : trunc(c.evidence, 90)) + "</td>" +
      (locked && renameable
        ? '<td><button class="add' + (cart.get(n.id)?.chosenName === c.name ? " added" : "") +
          '" data-add="' + esc(c.name) + '">+ name:' + esc(c.name) + "</button></td>"
        : "") +
      "</tr>"
    ).join("") + "</table>";
  } else if (n.genericReason) {
    html += '<div style="color:var(--dim)">no usable candidates — engine refused to suggest (see rejected below)</div>';
  }
  if (n.corroborating?.length) {
    html += '<div style="margin-top:6px;color:var(--high);font-weight:600">corroborates current name</div>';
    html += "<table>" + n.corroborating.map(c =>
      "<tr><td>" + esc(c.name) + '</td><td class="conf">' + c.confidence.toFixed(2) +
      "</td><td>" + esc(c.source) + "</td><td>" + esc(locked ? c.evidence : trunc(c.evidence, 60)) + "</td></tr>"
    ).join("") + "</table>";
  }
  if (n.rejected?.length) {
    html += '<div style="margin-top:6px;color:var(--nosig);font-weight:600">rejected candidates</div>';
    html += "<table>" + n.rejected.map(c =>
      '<tr><td style="text-decoration:line-through">' + esc(c.name) + '</td><td class="conf">' + c.confidence.toFixed(2) +
      "</td><td>" + esc(c.source) + '</td><td style="color:var(--nosig)">' + esc(locked ? c.reason : trunc(c.reason, 60)) + "</td></tr>"
    ).join("") + "</table>";
  }
  if (n.endpoints?.length) {
    const eps = locked ? n.endpoints : n.endpoints.slice(0, 6);
    html += '<div style="margin-top:6px" class="ep">endpoints: ' + esc(eps.join("  ")) + "</div>";
  }
  if (locked && TOOL_BY_TYPE[n.type]) {
    html += '<div class="how"><h4>HOW A RENAME APPLIES (' + ENTITYTYPE_BY_TYPE[n.type] + ')</h4><ol>' +
      '<li><b>now:</b> ' + TOOL_BY_TYPE[n.type] + ' writes a reversible <b>name:&lt;chosen&gt;</b> tag ' +
      '(audited, lattice-validated' + (n.decision === "no_signal" ? ", queued as operator_override — engine had no confident candidate" : ", queued as operator_confirmed") + '). Add createNamingRule:true to do step 2 in the same call. ' +
      'Rules and queries match <b>tag(name:&lt;chosen&gt;)</b> immediately.</li>' +
      '<li><b>display rename:</b> a conditional-naming rule (dt_raw_post → /api/config/v1/conditionalNaming/) keyed on that tag rewrites the UI name. Generated in the cart export.</li>' +
      '<li><b>at source:</b> ' + esc(AT_SOURCE_HINTS[n.type]) + '</li>' +
      '</ol></div>';
    html += '<div class="custom"><input id="customName" placeholder="custom name (operator_override)..."><button class="add" data-addcustom="1">+ add</button></div>';
  }
  if (locked) html += '<div class="hint">buttons queue a rename into the cart (bottom right) — the export shows the exact MCP call. Click empty space or Esc to release.</div>';
  return html;
}

function focusNode(n) {
  document.querySelectorAll(".edge").forEach(e => {
    e.classList.toggle("hot", e.dataset.from === n.id || e.dataset.to === n.id);
  });
  document.querySelectorAll("g.node").forEach(o => {
    const near = o.dataset.id === n.id || (adj.get(n.id) ?? new Set()).has(o.dataset.id);
    o.classList.toggle("dim", !near);
    o.classList.toggle("locked", state.locked === n.id && o.dataset.id === n.id);
  });
}

function clearFocus() {
  const tip = document.getElementById("tip");
  tip.style.display = "none";
  tip.classList.remove("locked");
  document.querySelectorAll(".edge.hot").forEach(e => e.classList.remove("hot"));
  document.querySelectorAll("g.node.dim").forEach(o => o.classList.remove("dim"));
  document.querySelectorAll("g.node.locked").forEach(o => o.classList.remove("locked"));
}

function releaseLock() {
  state.locked = null;
  state.lockedMode = null;
  document.querySelectorAll("g.nbtn.active").forEach(b => b.classList.remove("active"));
  clearFocus();
}

function wire() {
  const tip = document.getElementById("tip");
  document.querySelectorAll("g.node").forEach(g => {
    g.addEventListener("mousemove", ev => {
      if (state.locked) return; // a locked view (path or details) owns the screen
      const n = byId.get(g.dataset.id);
      tip.innerHTML = tipHTML(n, false);
      tip.classList.remove("locked");
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 14, innerWidth - 540) + "px";
      tip.style.top = (ev.clientY + 14) + "px";
      focusNode(n);
    });
    g.addEventListener("mouseleave", () => {
      if (state.locked) return;
      clearFocus();
    });
    // Node-body clicks are intentionally inert — actions live on the two
    // explicit buttons (⌖ path highlight, ⓘ pinned details).
  });
}

// Delegated once on the container (survives re-renders): the per-node buttons.
document.getElementById("wrap").addEventListener("click", ev => {
  const btn = ev.target.closest("g.nbtn");
  if (!btn) return;
  ev.stopPropagation();
  const n = byId.get(btn.dataset.id);
  if (!n) return;
  const tip = document.getElementById("tip");
  if (btn.dataset.btn === "path") {
    // Toggle: same node's path button releases; otherwise lock path only.
    if (state.locked === n.id && state.lockedMode === "path") { releaseLock(); return; }
    releaseLock();
    state.locked = n.id;
    state.lockedMode = "path";
    tip.style.display = "none";
    focusNode(n);
    btn.classList.add("active");
    return;
  }
  if (btn.dataset.btn === "info") {
    if (state.locked === n.id && state.lockedMode === "info") { releaseLock(); return; }
    releaseLock();
    state.locked = n.id;
    state.lockedMode = "info";
    tip.innerHTML = tipHTML(n, true);
    tip.classList.add("locked");
    tip.style.display = "block";
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - 540) + "px";
    tip.style.top = Math.min(ev.clientY + 14, innerHeight - 200) + "px";
    focusNode(n);
  }
});

// Click anywhere outside a node releases the lock. The tooltip itself is
// exempt so its text stays selectable while locked.
document.getElementById("tip").addEventListener("click", ev => {
  if (!state.locked) return;
  const n = byId.get(state.locked);
  const addBtn = ev.target.closest("button[data-add]");
  if (addBtn) {
    // operator clicked an engine candidate → operator_confirmed satisfies the
    // lattice (name is in the report's candidate list). no_signal buckets
    // only allow operator_override.
    const source = n.decision === "no_signal" ? "operator_override" : "operator_confirmed";
    cartAdd(n.id, addBtn.dataset.add, source);
    document.getElementById("tip").innerHTML = tipHTML(n, true);
    return;
  }
  const customBtn = ev.target.closest("button[data-addcustom]");
  if (customBtn) {
    const v = document.getElementById("customName").value.trim();
    if (v) { cartAdd(n.id, v, "operator_override"); document.getElementById("tip").innerHTML = tipHTML(n, true); }
    return;
  }
});
document.addEventListener("click", ev => {
  if (!state.locked) return;
  if (ev.target.closest("#tip") || ev.target.closest("#cart") || ev.target.closest("#export")) return;
  releaseLock();
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") releaseLock();
});

document.getElementById("onlyFlagged").addEventListener("change", e => { state.onlyFlagged = e.target.checked; render(); });
document.getElementById("showPGIs").addEventListener("change", e => { state.showPGIs = e.target.checked; render(); });
document.getElementById("search").addEventListener("input", e => { state.search = e.target.value.trim(); render(); });
render();
</script>
</body>
</html>`;
}

main().catch((err) => {
  console.error(`[graph] error: ${err instanceof Error ? err.stack : err}`);
  void stopEngine().catch(() => undefined);
  process.exit(1);
});
