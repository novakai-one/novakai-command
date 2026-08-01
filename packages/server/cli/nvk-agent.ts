#!/usr/bin/env -S npx tsx
// nvk-agent — spawn and run a governed team, from anywhere (§17.1).
//
//   nvk-agent roles
//   nvk-agent spawn --role <name|id> --name <name> [--task "<brief>"]
//                   [--provider claude|codex|kimi] [--model <id>] [--effort <v>]
//                   [--cwd <path>]
//   nvk-agent list [--state live|final|all]
//   nvk-agent tree --root <agentId>
//   nvk-agent inspect <agentRunId>
//   nvk-agent interrupt <agentRunId>
//   nvk-agent stop <agentId> --run <agentRunId> --confirm stop-one
//   nvk-agent stop-tree <agentId> --prepare
//   nvk-agent stop-tree <agentId> --token <token> --confirm stop-tree
//   nvk-agent continue <agentId> --from <agentRunId>
//                      --mode resume|fresh|compact|handover
//                      --config inherit-plan|refresh-role
//   nvk-agent adopt <agentId> --supervisor <agentId|human> --expect <n>
//   nvk-agent operations
//
// Every command takes --json; mutations take --client-op-id (§17.2), so
// re-running the exact command resumes the exact operation.
//
// This CLI is the SAME operation the in-app path uses — red gate 23 says
// similar callers may not travel different policy paths, and the cheapest way
// to hold that is to have no second path at all.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b3err, b3fail, b3ok,
  type B3ClientOpId, type B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentRunTreeView, AgentRunView, RunOperationView, StopTreeConfirmation,
  SupervisionAssignment,
} from '../../agent-runtime/contract/index.js';
import type { AgentRoleProfile } from '../../agents/b3/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, emit, fail, parseFlags, type Flags,
} from '../core/b3/cli-shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const [, , command = 'list', ...rest] = process.argv;
const flags = parseFlags(rest);
const root = flags.value('root') ?? process.env['NOVAKAI_ROOT'] ?? path.join(repoRoot, '.novakai');
const port = Number(flags.value('port') ?? process.env['NOVAKAI_RUNTIME_PORT'] ?? 5190);

/**
 * How an Agent running INSIDE a managed PTY authenticates as itself: the
 * Runtime put these in its environment at launch (DEC-B3V4-05). A human at a
 * keyboard has neither and connects as themselves.
 */
const runIdentity = {
  agentRunId: process.env['NVK_AGENT_RUN_ID'],
  runToken: process.env['NVK_AGENT_RUN_TOKEN'],
};

const mintedOperationId = clientOpIdFrom(flags);
const operationId = (): B3ClientOpId =>
  (mintedOperationId.ok ? mintedOperationId.value : ('' as B3ClientOpId));

const unreachable = (cause: unknown): ReturnType<typeof b3err> => b3err('RuntimeUnavailable',
  `no Novakai Runtime is reachable on port ${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
  { reason: 'not-reachable' }, true);

async function withClient<Value>(
  work: (client: RuntimeClient) => Promise<B3Result<Value>>,
): Promise<B3Result<Value>> {
  let client: RuntimeClient;
  try {
    client = await connectRuntime({
      root,
      port,
      ...(runIdentity.agentRunId === undefined || runIdentity.runToken === undefined
        ? {}
        : { agentRunId: runIdentity.agentRunId, runToken: runIdentity.runToken }),
    });
  } catch (cause) {
    return b3fail(unreachable(cause));
  }
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

/** A role by NAME, because that is what Chris types. */
async function roleIdFor(client: RuntimeClient, given: string): Promise<B3Result<string>> {
  if (given.startsWith('agentRole_')) return b3ok(given);
  const roles = await client.call<readonly AgentRoleProfile[]>('b3.agent.getRoles', {});
  if (!roles.ok) return roles;
  const matched = roles.value.filter((role) => role.name === given && role.status === 'active');
  if (matched.length === 0) {
    return b3fail(b3err('RoleNotAllowed',
      `no active role is named "${given}"; try \`nvk-agent roles\``,
      { roleProfileId: given }, false));
  }
  if (matched.length > 1) {
    return b3fail(b3err('RoleNotAllowed',
      `${matched.length} active roles are named "${given}"; name it by id`,
      { roleProfileId: given }, false));
  }
  return b3ok(matched[0]!.id);
}

/**
 * The sentence Chris needs, with the four facts kept apart: where it came from,
 * who supervises it, what it is doing, and what we do NOT know (§24.5).
 */
function describeRun(view: AgentRunView): string {
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
    + `  ${view.family.childCount} child agent(s); usage ${view.usage.quality} (${view.usage.reason})`
    + doubts;
}

const describeList = (views: readonly AgentRunView[]): string =>
  (views.length === 0 ? 'No agent runs.' : views.map(describeRun).join('\n\n'));

/** Indented by generation, so the family reads as a family. */
function describeTree(tree: AgentRunTreeView): string {
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

const COMMANDS: Record<string, (argFlags: Flags) => Promise<never>> = {
  async roles(argFlags) {
    emit('agent roles', argFlags, await withClient<readonly AgentRoleProfile[]>(
      (client) => client.call('b3.agent.getRoles', {}),
    ), (found) => (found.length === 0
      ? 'No roles are defined yet.'
      : found.map((role) => `${role.name}  ${role.status}  ${role.id}\n`
        + `  ${role.providerPolicy.allowed.join('/')} · models ${role.modelPolicy.allowedModelIds.join(', ')}`
        + ` · gate ${role.skillsConfirmationGate.mode}`).join('\n')));
  },

  async spawn(argFlags) {
    const role = argFlags.value('role');
    const displayName = argFlags.value('name');
    if (!role || !displayName) {
      return usage('agent spawn', argFlags, '--role <name|id> --name <name> [--task "<brief>"]');
    }
    const task = argFlags.value('task');
    emit('agent spawn', argFlags, await withClient<AgentRunView>(async (client) => {
      const roleId = await roleIdFor(client, role);
      if (!roleId.ok) return roleId;
      return client.call('b3.agent.spawn', {
        roleProfileId: roleId.value,
        displayName,
        workingDirectory: argFlags.value('cwd') ?? process.cwd(),
        ...(argFlags.value('provider') === undefined
          ? {} : { requestedProvider: argFlags.value('provider') }),
        ...(argFlags.value('model') === undefined
          ? {} : { requestedModelId: argFlags.value('model') }),
        ...(argFlags.value('effort') === undefined
          ? {} : { requestedEffort: argFlags.value('effort') }),
        ...(task === undefined ? {} : { task: { kind: 'supervised', brief: task } }),
      }, operationId());
    }), describeRun);
  },

  async list(argFlags) {
    const state = argFlags.value('state') ?? 'all';
    emit('agent list', argFlags, await withClient<{ items: readonly AgentRunView[] }>(
      (client) => client.call('b3.agent.listRuns', {
        includeFinal: state !== 'live',
        ...(state === 'final' ? { lifecycle: ['stopped', 'failed', 'interrupted'] } : {}),
        limit: 200,
      }),
    ), (page) => describeList(page.items));
  },

  async tree(argFlags) {
    const rootAgentId = argFlags.value('root') ?? argFlags.positional[0];
    if (!rootAgentId) return usage('agent tree', argFlags, '--root <agentId>');
    emit('agent tree', argFlags, await withClient<AgentRunTreeView>(
      (client) => client.call('b3.agent.getTree', { rootAgentId, maxDepth: 8 }),
    ), describeTree);
  },

  async inspect(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent inspect', argFlags, '<agentRunId>');
    emit('agent inspect', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.getRun', { agentRunId }),
    ), describeRun);
  },

  async interrupt(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent interrupt', argFlags, '<agentRunId>');
    emit('agent interrupt', argFlags, await withClient(async (client) => {
      const view = await client.call<AgentRunView>('b3.agent.getRun', { agentRunId });
      if (!view.ok) return view;
      return client.call<{ kind: string }>('b3.agent.interrupt', {
        agentRunId, expectedRecordVersion: view.value.run.recordVersion,
      }, operationId());
    }), (outcome) => (outcome.kind === 'not-working'
      ? 'That agent was not working; nothing was changed.'
      : `Interrupted (${outcome.kind}). The agent is still running; its children are untouched.`));
  },

  async stop(argFlags) {
    const agentId = argFlags.positional[0];
    const agentRunId = argFlags.value('run');
    if (!agentId || !agentRunId || argFlags.value('confirm') !== 'stop-one') {
      return usage('agent stop', argFlags, '<agentId> --run <agentRunId> --confirm stop-one');
    }
    emit('agent stop', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.stop', {
        agentId, expectedLiveRunId: agentRunId, confirmation: 'stop-one',
      }, operationId()),
    ), (view) => `Stopped ${view.agent.displayName}. Its children keep running; `
      + 'their supervision moved to the nearest live ancestor.');
  },

  'stop-tree': async (argFlags) => {
    const rootAgentId = argFlags.positional[0];
    if (!rootAgentId) {
      return usage('agent stop-tree', argFlags, '<agentId> --prepare | --token <t> --confirm stop-tree');
    }
    if (argFlags.value('prepare') !== undefined) {
      return emit('agent stop-tree', argFlags, await withClient<StopTreeConfirmation>(
        (client) => client.call('b3.agent.prepareStopTree', { rootAgentId }, operationId()),
      ), (confirmation) => `This will stop ${confirmation.visibleDescendantCount} agent(s) `
        + `below ${confirmation.rootAgentId}, and that agent.\n`
        + `To go ahead: nvk-agent stop-tree ${confirmation.rootAgentId} `
        + `--token ${confirmation.confirmationToken} --confirm stop-tree`);
    }
    const token = argFlags.value('token');
    if (!token || argFlags.value('confirm') !== 'stop-tree') {
      return usage('agent stop-tree', argFlags, '<agentId> --token <t> --confirm stop-tree');
    }
    return emit('agent stop-tree', argFlags, await withClient<RunOperationView>(
      (client) => client.call('b3.agent.stopTree', {
        rootAgentId, confirmationToken: token, confirmation: 'stop-tree',
      }, operationId()),
    ), (view) => view.perAgentOutcomes
      .map((outcome) => `${outcome.agentId}: ${outcome.outcome}${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`)
      .join('\n'));
  },

  async continue(argFlags) {
    const agentId = argFlags.positional[0];
    const fromRunId = argFlags.value('from');
    const mode = argFlags.value('mode');
    if (!agentId || !fromRunId || !mode) {
      return usage('agent continue', argFlags,
        '<agentId> --from <agentRunId> --mode resume|fresh|compact|handover [--config inherit-plan|refresh-role]');
    }
    emit('agent continue', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.continue', {
        agentId,
        expectedOldRunId: fromRunId,
        mode,
        configurationMode: argFlags.value('config') ?? 'inherit-plan',
        ...(argFlags.value('handover-artifact') === undefined
          ? {} : { handoverArtifactId: argFlags.value('handover-artifact') }),
      }, operationId()),
    ), (view) => `${view.agent.displayName} is running again as ${view.run.id} (${mode}).\n`
      + '  Same agent, same family; a new run. The old one is recorded as replaced.');
  },

  async adopt(argFlags) {
    const subjectAgentId = argFlags.positional[0];
    const supervisor = argFlags.value('supervisor');
    const expected = argFlags.value('expect');
    if (!subjectAgentId || !supervisor || expected === undefined) {
      return usage('agent adopt', argFlags,
        '<agentId> --supervisor <agentId|human:<principal>> --expect <generation>');
    }
    emit('agent adopt', argFlags, await withClient<SupervisionAssignment>(
      (client) => client.call('b3.agent.adopt', {
        subjectAgentId,
        expectedAssignmentVersion: Number(expected),
        supervisor: supervisor.startsWith('human:')
          ? { kind: 'human', principalId: supervisor.slice('human:'.length) }
          : { kind: 'agent', agentId: supervisor },
      }, operationId()),
    ), () => `${subjectAgentId} now answers to ${supervisor}. Who SPAWNED it is unchanged.`);
  },

  async operations(argFlags) {
    emit('agent operations', argFlags, await withClient<readonly RunOperationView[]>(
      (client) => client.call('b3.agent.listOperations', {}),
    ), (found) => (found.length === 0
      ? 'No operations recorded.'
      : found.map((item) => `${item.operation.kindOfOperation}  ${item.operation.state}  `
        + `${item.operation.currentStage}  ${item.operation.id}`).join('\n')));
  },
};

async function runCommand(name: string, argFlags: Flags): Promise<never> {
  if (!mintedOperationId.ok) return fail(`agent ${name}`, argFlags, mintedOperationId.error);
  const handler = COMMANDS[name];
  if (!handler) {
    return usage('agent', argFlags,
      'roles|spawn|list|tree|inspect|interrupt|stop|stop-tree|continue|adopt|operations');
  }
  return handler(argFlags);
}

function usage(command: string, argFlags: Flags, expected: string): never {
  emit(command, argFlags, b3fail(
    b3err('ValidationFailed', `usage: nvk-agent ${command.split(' ')[1] ?? ''} ${expected}`,
      { issues: [{ path: 'argv', message: `expected ${expected}` }] }, false),
  ), () => '');
}

await runCommand(command, flags);
