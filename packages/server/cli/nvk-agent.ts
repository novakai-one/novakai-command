#!/usr/bin/env -S npx tsx
// nvk-agent — spawn and run a governed team, from anywhere (§17.1).
//
//   nvk-agent roles
//   nvk-agent spawn --role <name|id> --name <name> [--task "<brief>"]
//                   [--provider claude|codex|kimi] [--model <id>] [--effort <v>]
//                   [--cwd <path>]
//   nvk-agent list [--state live|final|all]
//   nvk-agent tree <agentId>
//   nvk-agent inspect <agentRunId>
//   nvk-agent attach <agentRunId>
//   nvk-agent controls <agentRunId>
//   nvk-agent control <agentRunId> --set model=<id>|effort=<v>|provider-setting=<v>
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
  AgentControlOutcomeFacts, AgentRunTreeView, AgentRunView, ControlCapabilityFacts,
  RunEventPage, RunOperationView, StopTreeConfirmation, SupervisionAssignment,
  TreeMutationFence,
} from '../../agent-runtime/contract/index.js';
import type { AgentRoleProfile, DelegationGrant } from '../../agents/b3/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, emit, fail, parseFlags, type Flags,
} from '../core/b3/cli-shared.js';
import { describeControls, describeList, describeRun, describeTree } from './agent-describe.js';
import { roleFromFile, roleIdFor } from './agent-roles.js';
import { observeCommands } from './agent-observe.js';

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
  // Half a credential is refused rather than dropped. A PTY whose environment
  // carries one variable and not the other is a broken Agent identity; treating
  // it as "no claim" promoted that Agent to Chris (NVK-KIMI-028 finding 1).
  if ((runIdentity.agentRunId === undefined) !== (runIdentity.runToken === undefined)) {
    return b3fail(b3err('PermissionDenied',
      'NVK_AGENT_RUN_ID and NVK_AGENT_RUN_TOKEN must both be set or both be unset',
      { reason: 'half-agent-run-credential' }, false));
  }
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

  /**
   * `nvk agent define-role --file <role.json>`.
   *
   * Without it a clean install can never spawn anything: `b3.agent.createRole`
   * was published on the wire and used by tests and the bundled proof, and no
   * operator surface called it, so "spawn a governed agent from anywhere" was
   * unreachable by CLI from a fresh data root (probe M-2).
   */
  async ['define-role'](argFlags) {
    const file = argFlags.value('file');
    if (file === undefined) {
      return usage('agent define-role', argFlags, '--file <role.json>');
    }
    const payload = roleFromFile(file);
    if (!payload.ok) return fail('agent define-role', argFlags, payload.error);
    emit('agent define-role', argFlags, await withClient<AgentRoleProfile>(
      (client) => client.call('b3.agent.createRole', payload.value, operationId()),
    ), (role) => `Defined role ${role.name} (${role.id}), gate ${role.skillsConfirmationGate.mode}.`);
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
    // NOT `--root`: that flag names the DATA root on every nvk CLI, and an
    // operator typing `--root agent_x` would have silently pointed the client
    // at a directory called `agent_x` as well as mis-targeting the tree.
    const rootAgentId = argFlags.value('agent') ?? argFlags.positional[0];
    if (!rootAgentId) return usage('agent tree', argFlags, '<agentId> | --agent <agentId>');
    const direction = argFlags.value('direction');
    emit('agent tree', argFlags, await withClient<AgentRunTreeView>(
      (client) => client.call('b3.agent.getTree', {
        rootAgentId, maxDepth: 8,
        ...(direction === undefined ? {} : { direction }),
      }),
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

  /**
   * Watch and type into a running Agent's terminal. It hands over to the
   * Terminal CLI rather than reimplementing attach: one attach path, one lease,
   * one stream (red gate 23).
   */
  async attach(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent attach', argFlags, '<agentRunId>');
    emit('agent attach', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.getRun', { agentRunId }),
    ), (view) => (view.run.terminalSessionId === undefined
      ? `${view.agent.displayName} has no terminal yet (${view.run.lifecycle}).`
      : `${view.agent.displayName} is on ${view.run.terminalSessionId}.\n`
        + `  Watch it:  nvk-terminal read ${view.run.terminalSessionId}\n`
        + `  Type into it:  nvk-terminal attach ${view.run.terminalSessionId}`));
  },

  async controls(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent controls', argFlags, '<agentRunId>');
    emit('agent controls', argFlags, await withClient<ControlCapabilityFacts>(
      (client) => client.call('b3.agent.controls', { agentRunId }),
    ), describeControls);
  },

  async control(argFlags) {
    const agentRunId = argFlags.positional[0];
    const setting = argFlags.value('set');
    const separator = setting?.indexOf('=') ?? -1;
    if (!agentRunId || setting === undefined || separator <= 0) {
      return usage('agent control', argFlags, '<agentRunId> --set model|effort|provider-setting=<value>');
    }
    emit('agent control', argFlags, await withClient<AgentControlOutcomeFacts>(async (client) => {
      // The version the CALLER read, so two people changing one Agent cannot
      // both silently win.
      const view = await client.call<AgentRunView>('b3.agent.getRun', { agentRunId });
      if (!view.ok) return view;
      return client.call('b3.agent.control', {
        agentRunId,
        expectedRunVersion: view.value.run.recordVersion,
        control: { name: setting.slice(0, separator), value: setting.slice(separator + 1) },
      }, operationId());
    }), (outcome) => {
      if (outcome.kind === 'applied-native') {
        return `Changed ${outcome.control.name} to ${outcome.control.value}, in place.`;
      }
      if (outcome.kind === 'unsupported') return `Not possible: ${outcome.reason}`;
      return 'That change needs a replacement run — nothing has changed yet.\n'
        + `  To go ahead: nvk-agent continue <agentId> --from ${agentRunId} `
        + `--mode fresh --config signed-control-replacement `
        + `--replacement ${outcome.replacementPlanId}`;
    });
  },

  ...observeCommands({ withClient, emit, usage, operationId }),

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
    // Derived from the table, so a verb added without a usage line is
    // impossible rather than merely unlikely.
    return usage('agent', argFlags, Object.keys(COMMANDS).join('|'));
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
