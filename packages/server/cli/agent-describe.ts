// How a governed team READS on a terminal (§24.5).
//
// Split out of `nvk-agent.ts` so that file is the commands and this one is the
// words. The rule they share: four facts are kept apart on purpose — where a
// Run came from, who supervises it, what it is doing, and what we do NOT know.
// Collapsing any of those into "running" is how a CLI starts lying quietly.
import type {
  AgentRunTreeView, AgentRunView, ControlCapabilityFacts,
} from '../../agent-runtime/contract/index.js';
import type {
  AgentRunUsage, AgentUsageSummary, UsageValue,
} from '../../supervision/contract/index.js';

function usageValue(value: UsageValue, label: string): string {
  const limitations = value.limitations.length === 0
    ? '' : `: ${value.limitations.join(', ')}`;
  return `${value.value === undefined ? '—' : value.value.toLocaleString('en-US')} `
    + `${label} (${value.quality}${limitations})`;
}

function usageLine(usage: Omit<AgentRunUsage, 'agentRunId'>): string {
  return `${usageValue(usage.inputTokens, 'input tokens')} · `
    + `${usageValue(usage.outputTokens, 'output tokens')} · `
    + `${usageValue(usage.cachedInputTokens, 'cached input tokens')} · `
    + `${usageValue(usage.costMicros, 'cost micros')} · `
    + usageValue(usage.providerTurns, 'provider turns');
}

/**
 * The sentence Chris needs, with the four facts kept apart: where it came from,
 * who supervises it, what it is doing, and what we do NOT know (§24.5).
 */
export function describeRun(view: AgentRunView): string {
  const supervisor = view.family.supervisor.kind === 'agent'
    ? `supervised by ${view.family.supervisor.agentId}`
    : view.family.supervisor.kind === 'human'
      ? `supervised by ${view.family.supervisor.principalId}`
      : `orphaned (${view.family.supervisor.reason})`;
  const family = view.family.parentAgentId === undefined
    ? 'a root agent' : `child of ${view.family.parentAgentId}`;
  const doubts = view.run.uncertainty.length === 0
    ? '' : `\n  Not known: ${view.run.uncertainty.map((item) => item.summary).join('; ')}`;
  return `${view.agent.displayName}  ${view.run.id}\n`
    + `  ${view.provider.provider}/${view.provider.modelId} (${view.provider.effort}); `
    + `${view.run.lifecycle}, ${view.run.activity}\n`
    + `  Started from ${view.launch.surface} by ${view.launch.requestedBy}; ${family}; ${supervisor}\n`
    + `  ${view.family.childCount} child agent(s); usage ${usageLine(view.usage)}`
    + doubts;
}

export const describeList = (views: readonly AgentRunView[]): string =>
  (views.length === 0 ? 'No agent runs.' : views.map(describeRun).join('\n\n'));

/** Indented by generation, so the family reads as a family. */
export function describeTree(tree: AgentRunTreeView): string {
  if (tree.nodes.length === 0) return 'No agents under that root.';
  const depthOf = new Map<string, number>([[tree.rootAgentId, 0]]);
  const lines: string[] = [];
  for (const node of tree.nodes) {
    const parent = node.family.parentAgentId;
    const depth = parent === undefined ? 0 : (depthOf.get(parent) ?? 0) + 1;
    depthOf.set(node.agent.agentId, depth);
    lines.push(`${'  '.repeat(depth)}${node.agent.displayName} `
      + `[${node.provider.provider}] ${node.run.lifecycle} — ${node.run.id}`);
  }
  return lines.join('\n');
}

export function describeControls(report: ControlCapabilityFacts): string {
  return `${report.provider} ${report.testedProviderVersion}\n`
    + report.controls.map((control) => `  ${control.name}  ${control.support}`
      + ` (${control.enforcement})${control.allowedValues === undefined
        ? '' : ` — ${control.allowedValues.join(', ')}`}\n    ${control.reason}`).join('\n');
}

/** Human usage output keeps uncertainty beside every value, including absence. */
export function describeUsage(usage: AgentRunUsage | AgentUsageSummary): string {
  if ('agentRunId' in usage) {
    return `${usage.agentRunId}\n  ${usageLine(usage)}\n`
      + `  observed ${usage.observedAt}; ${usage.final ? 'final' : 'live'}`;
  }
  const runs = usage.runs.length === 0
    ? '  No Runs.'
    : usage.runs.map((item) => `  ${item.agentRunId}  ${usageLine(item)}`).join('\n');
  return `${usage.agentId}\n  Aggregate  ${usageLine(usage.aggregate)}\n${runs}`;
}
