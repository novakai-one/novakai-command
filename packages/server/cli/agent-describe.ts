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
import type { Agent } from '../../agents/b3/contract/index.js';

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
 * §17.2:3605's second half: "Human output MUST say both launch origin and
 * current controller truth" — the `currently 0 controllers` clause.
 *
 * It is a separate clause from the origin on purpose. §24.5 red-gates the two
 * against each other ("'Started externally' is not inferred from current
 * attachment", "'No controller' is not 'Agent stopped'"), so the line states
 * both rather than letting a reader derive one from the other.
 *
 * An absent `inputLeaseHolder` is passed over in silence, because the owner
 * omits it to mean "no lease holder" — printing "unknown" would turn a stated
 * fact into a doubt.
 */
function controllerLine(controllers: AgentRunView['controllers']): string {
  const count = controllers.attachedCount;
  const noun = count === 1 ? 'controller' : 'controllers';
  const kinds = controllers.kinds.length === 0 ? '' : ` (${controllers.kinds.join(', ')})`;
  const holder = controllers.inputLeaseHolder === undefined
    ? '' : `, input lease held by ${controllers.inputLeaseHolder}`;
  return `currently ${count} ${noun}${kinds}${holder}`;
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
    + `  Started from ${view.launch.surface} by ${view.launch.requestedBy}; `
    + `${controllerLine(view.controllers)}; ${family}; ${supervisor}\n`
    + `  ${view.family.childCount} child agent(s); usage ${usageLine(view.usage)}`
    + doubts;
}

export const describeList = (views: readonly AgentRunView[]): string =>
  (views.length === 0 ? 'No agent runs.' : views.map(describeRun).join('\n\n'));

/**
 * The Agent, not a Run of it (OQ-09's agent form). Deliberately short: an
 * Agent is an identity and a role, and everything that is "happening" belongs
 * to a Run. Saying more here would invite reading a Run's state off an Agent.
 */
export const describeAgent = (agent: Agent): string =>
  `${agent.displayName}  ${agent.id}\n  role ${agent.roleProfileId}; ${agent.status}; `
  + `belongs to ${agent.rootHumanPrincipalId}`;

/** Indented by generation, so the family reads as a family. */
export function describeTree(tree: AgentRunTreeView): string {
  if (tree.nodes.length === 0) return 'No agents under that root.';
  // L-13: `depth` is the owner's own answer (§12.7), so it is read, not
  // recomputed. The walk this replaces derived each generation from
  // `family.parentAgentId` IN ARRAY ORDER — `depthOf.get(parent) ?? 0` — which
  // silently turned "I have not reached that parent yet" into "it is the root".
  // Node order is not promised to be parents-first, so a child listed before
  // its parent was drawn a generation too shallow, and the CLI and the Shell
  // could print two different families from one answer (FZ-VIEW-034).
  return tree.nodes.map((node) =>
    `${'  '.repeat(node.depth)}${node.agent.displayName} `
    + `[${node.provider.provider}] ${node.run.lifecycle} — ${node.run.id}`).join('\n');
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
