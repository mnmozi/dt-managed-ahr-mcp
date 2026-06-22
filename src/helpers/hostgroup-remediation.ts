/**
 * Pure text-generation helper for dt_export_hostgroup_remediation.
 *
 * Takes the dt_audit_host_groups output + a list of operator-approved
 * findings, and emits ready-to-run oneagentctl commands. No Dynatrace
 * API calls — Dynatrace can't change host-group membership remotely;
 * this layer's "remediation" is text the operator (or their config-
 * management pipeline) executes on the target hosts.
 *
 * Also emits an Ansible-friendly inventory fragment when there are
 * enough hosts to make it worth the operator's while (≥ 2 hosts).
 */

import type {
  HostGroupsCoverageAuditOutput,
  HostReassign,
} from "../engine/analyzers/hostgroups-coverage-audit.js";

/**
 * What the operator picks from the audit. They select findings by
 * category + a stable identifier (hostId for hostsWithoutGroup,
 * fleetKey for splitFleets). Picking a splitFleet remediates every
 * member host that needs reassignment.
 *
 * For hostsWithoutGroup, an optional `assignToGroup` lets the operator
 * override the engine's `fleetSuggestion` (or supply one when the
 * engine didn't have a suggestion).
 */
export interface RemediationSelector {
  hostsWithoutGroup?: Array<{ hostId: string; assignToGroup?: string }>;
  splitFleets?: string[]; // fleetKeys to act on
}

export interface RemediationCommand {
  hostId: string;
  hostDisplayName?: string;
  currentGroup: string; // "<none>" when the host had no group
  newGroup: string;
  reason: string;
  command: string;
}

export interface RemediationOutput {
  commandsByHost: RemediationCommand[];
  ansibleInventoryFragment?: string;
  summary: {
    commandsGenerated: number;
    hostsAffected: number;
    estimatedDowntimeSeconds: number;
  };
  /** When the operator's selector picks something not in the audit, we surface it here so they can fix the call. */
  unmatchedSelectors: string[];
}

const ONEAGENTCTL_CMD = "sudo /opt/dynatrace/oneagent/agent/tools/oneagentctl";

/**
 * Generate the command set. Pure function — same input → same output.
 *
 * Error-tolerant: unrecognized hostIds / fleetKeys go into
 * `unmatchedSelectors` rather than throwing, so the operator can
 * iterate on the selector list.
 */
export function generateRemediation(
  audit: HostGroupsCoverageAuditOutput,
  selector: RemediationSelector
): RemediationOutput {
  const out: RemediationOutput = {
    commandsByHost: [],
    summary: {
      commandsGenerated: 0,
      hostsAffected: 0,
      estimatedDowntimeSeconds: 0,
    },
    unmatchedSelectors: [],
  };

  const seenHostIds = new Set<string>();

  // ---- hostsWithoutGroup ----
  for (const pick of selector.hostsWithoutGroup ?? []) {
    const entry = audit.hostsWithoutGroup.find((h) => h.hostId === pick.hostId);
    if (!entry) {
      out.unmatchedSelectors.push(`hostsWithoutGroup: hostId='${pick.hostId}' not in audit`);
      continue;
    }
    const target = pick.assignToGroup ?? entry.fleetSuggestion;
    if (!target) {
      out.unmatchedSelectors.push(
        `hostsWithoutGroup: hostId='${pick.hostId}' has no fleetSuggestion and no assignToGroup was supplied`
      );
      continue;
    }
    if (seenHostIds.has(entry.hostId)) continue;
    seenHostIds.add(entry.hostId);
    out.commandsByHost.push({
      hostId: entry.hostId,
      hostDisplayName: entry.displayName,
      currentGroup: "<none>",
      newGroup: target,
      reason: entry.evidence ?? `operator-supplied target '${target}'`,
      command: oneagentctlSetGroup(target),
    });
  }

  // ---- splitFleets ----
  for (const fleetKey of selector.splitFleets ?? []) {
    const entry = audit.splitFleets.find((f) => f.fleetKey === fleetKey);
    if (!entry) {
      out.unmatchedSelectors.push(`splitFleets: fleetKey='${fleetKey}' not in audit`);
      continue;
    }
    if (!entry.suggestedGroup) {
      out.unmatchedSelectors.push(
        `splitFleets: fleetKey='${fleetKey}' has no suggestedGroup (engine couldn't pick a plurality)`
      );
      continue;
    }
    for (const r of entry.hostsToReassign) {
      if (seenHostIds.has(r.hostId)) continue; // dedupe across findings
      seenHostIds.add(r.hostId);
      out.commandsByHost.push(toCommand(r));
    }
  }

  // Sort for stable output.
  out.commandsByHost.sort((a, b) => (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0));

  out.summary.commandsGenerated = out.commandsByHost.length;
  out.summary.hostsAffected = seenHostIds.size;
  // Empirical: OneAgent restart is fast (10-20s); pad a little.
  out.summary.estimatedDowntimeSeconds = seenHostIds.size > 0 ? 30 : 0;

  if (out.commandsByHost.length >= 2) {
    out.ansibleInventoryFragment = renderAnsibleFragment(out.commandsByHost);
  }

  return out;
}

function oneagentctlSetGroup(group: string): string {
  // group is operator-supplied — defensively quote if it has shell-metas.
  const safe = /^[A-Za-z0-9._-]+$/.test(group) ? group : `"${group.replace(/"/g, '\\"')}"`;
  return `${ONEAGENTCTL_CMD} --set-host-group=${safe} --restart-service`;
}

function toCommand(r: HostReassign): RemediationCommand {
  return {
    hostId: r.hostId,
    hostDisplayName: r.displayName,
    currentGroup: r.currentGroup && r.currentGroup.length > 0 ? r.currentGroup : "<none>",
    newGroup: r.newGroup,
    reason: r.reason,
    command: oneagentctlSetGroup(r.newGroup),
  };
}

/**
 * Render an Ansible inventory fragment grouping hosts by their target
 * host group. The operator can drop this into a playbook that runs the
 * oneagentctl command via the `shell` module.
 */
function renderAnsibleFragment(cmds: RemediationCommand[]): string {
  // Group by newGroup.
  const byGroup = new Map<string, RemediationCommand[]>();
  for (const c of cmds) {
    if (!byGroup.has(c.newGroup)) byGroup.set(c.newGroup, []);
    byGroup.get(c.newGroup)!.push(c);
  }
  const sections: string[] = [
    "# Generated by dt_export_hostgroup_remediation.",
    "# Each section lists hosts that should be moved to the named host group.",
    "# Use with a playbook that runs the oneagentctl command via the shell module.",
    "",
  ];
  for (const [group, members] of [...byGroup.entries()].sort()) {
    sections.push(`[set_host_group__${group.replace(/[^A-Za-z0-9]+/g, "_")}]`);
    for (const m of members) {
      const label = m.hostDisplayName && m.hostDisplayName.length > 0 ? m.hostDisplayName : m.hostId;
      sections.push(`${label}  # was: ${m.currentGroup}`);
    }
    sections.push("");
  }
  return sections.join("\n");
}
