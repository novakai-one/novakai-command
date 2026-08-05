#!/usr/bin/env -S npx tsx
// nvk-agent — spawn and run a governed team, from anywhere (§17.1).
//
//   nvk-agent roles
//   nvk-agent spawn --role <name|id> --name <name> [--task "<brief>"]
//                   [--provider claude|codex|kimi] [--model <id>] [--effort <v>]
//                   [--cwd <path>]
//   nvk-agent list [--state live|final|all]
//   nvk-agent tree <agentId> [--depth <n>]
//   nvk-agent inspect <agentRunId>
//   nvk-agent usage <agentId|agentRunId>
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
import type { Agent, AgentRoleProfile, DelegationGrant } from '../../agents/b3/contract/index.js';
import type { AgentRunUsage, AgentUsageSummary } from '../../supervision/contract/index.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import {
  clientOpIdFrom, emit, fail, isRunForm, pageFlags, parseFlags, verbOf,
  type CliCommand, type Flags,
} from '../core/b3/cli-shared.js';
import {
  describeAgent, describeControls, describeList, describeRun, describeTree, describeUsage,
} from './agent-describe.js';
import { roleFromFile, roleIdFor } from './agent-roles.js';
import { messageCommands } from './agent-messages.js';
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

/**
 * A5-09's `--depth <n>` → `GetAgentRunTreeInput.maxDepth`, published default 10.
 *
 * The CLI checks the ENCODING (is this a whole number?) and nothing else: the
 * range belongs to the owner, which bounds `maxDepth` at its frozen boundary,
 * and a second opinion here would be CLI-only policy (OQ-06). What it must not
 * do is forward `NaN` and let the owner report a shape it never saw.
 */
const DEFAULT_TREE_DEPTH = 10;

function treeDepth(argFlags: Flags): B3Result<number> {
  const given = argFlags.value('depth');
  if (given === undefined) return b3ok(DEFAULT_TREE_DEPTH);
  const depth = Number(given);
  if (!Number.isInteger(depth)) {
    return b3fail(b3err('ValidationFailed', '--depth must be a whole number',
      { issues: [{ path: 'depth', message: 'must be a whole number' }] }, false));
  }
  return b3ok(depth);
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
      return usage('agent.spawn', argFlags, '--role <name|id> --name <name> [--task "<brief>"]');
    }
    const task = argFlags.value('task');
    emit('agent.spawn', argFlags, await withClient<AgentRunView>(async (client) => {
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

  /**
   * `nvk agent list [--state live|final|all] [--limit <n>] [--cursor <c>]`.
   *
   * `--state` maps ONLY to `includeFinal`/`onlyFinal` (AMD-005 A5-06, OQ-07
   * ruling): no lane computes liveness. `interrupted` is final only once
   * reconciliation confirms no live provider process, so a CLI that filtered on
   * the lifecycle enum would be publishing its own answer to a question the
   * owner alone can answer — the B3d SEVERE-2 shape.
   *
   * `--limit`/`--cursor` are A5-01, passed through unchanged: the CLI never
   * re-pages, merges pages, filters items or recomputes `omissions`.
   */
  async list(argFlags) {
    const state = argFlags.value('state') ?? 'live';
    const page = pageFlags(argFlags);
    if (!page.ok) return fail('agent.list', argFlags, page.error);
    emit('agent.list', argFlags, await withClient<{ items: readonly AgentRunView[] }>(
      (client) => client.call('b3.agent.listRuns', {
        includeFinal: state !== 'live',
        ...(state === 'final' ? { onlyFinal: true } : {}),
        ...page.value,
      }),
    ), (listed) => describeList(listed.items));
  },

  /**
   * A5-09 as superseded by NVK-KIMI-093: `nvk agent tree <agentId> [--depth <n>]`.
   *
   * The selector is a bare positional, which is §17.1's own idiom for an Agent
   * subject (`inspect`, `attach`, `stop`, `usage`, … all take it that way) and
   * the one spelling that cannot collide: `--root <path>` names the DATA root
   * on every `nvk` command, and an operator typing `--root agent_x` would have
   * pointed the client at a directory called `agent_x` as well as mis-targeting
   * the tree. The `--agent` alias this CLI shipped goes with it — E1 forbids
   * adding or renaming a flag on a ratified command, whichever direction it
   * improves things in.
   */
  async tree(argFlags) {
    const rootAgentId = argFlags.positional[0];
    // The §12.7 input field, not a flag: `--root` is not a spelling of this
    // argument any more, so naming it in the issue would point at nothing.
    if (!rootAgentId) {
      return fail('agent.tree', argFlags,
        b3err('ValidationFailed', 'usage: nvk agent tree <agentId> [--depth <n>]',
          { issues: [{ path: 'rootAgentId', message: 'required' }] }, false));
    }
    const depth = treeDepth(argFlags);
    if (!depth.ok) return fail('agent.tree', argFlags, depth.error);
    // `direction` is deliberately absent: pass2 §12.7's input is
    // `{rootAgentId, maxDepth}` and OQ-08 dissolved the question, so a
    // `--direction` flag would be unratified input on a ratified command.
    emit('agent.tree', argFlags, await withClient<AgentRunTreeView>(
      (client) => client.call('b3.agent.getTree', { rootAgentId, maxDepth: depth.value }),
    ), describeTree);
  },

  /**
   * OQ-09: one command, two value types. The §4.1 prefix picks BOTH the
   * operation and the shape you get back, and `command` (X-1) is what tells the
   * caller which — an `agentRun_` id resolves to the Run's view, anything else
   * to the Agent itself. No field sniffing, no schema change.
   */
  async inspect(argFlags) {
    const target = argFlags.positional[0];
    if (isRunForm(target)) {
      return emit('agent.inspect.run', argFlags, await withClient<AgentRunView>(
        (client) => client.call('b3.agent.getRun', { agentRunId: target }),
      ), describeRun);
    }
    if (!target) return usage('agent.inspect.agent', argFlags, '<agentId|agentRunId>');
    return emit('agent.inspect.agent', argFlags, await withClient<Agent>(
      (client) => client.call('b3.agent.getAgent', { agentId: target }),
    ), describeAgent);
  },

  /** OQ-16, the same shape as OQ-09: prefix picks the form, `command` says so. */
  async usage(argFlags) {
    const target = argFlags.positional[0];
    if (isRunForm(target)) {
      return emit('agent.usage.run', argFlags, await withClient<AgentRunUsage>(
        (client) => client.call('b3.supervision.getRunUsage', { agentRunId: target }),
      ), describeUsage);
    }
    if (!target) return usage('agent.usage.agent', argFlags, '<agentId|agentRunId>');
    return emit('agent.usage.agent', argFlags, await withClient<AgentUsageSummary>(
      (client) => client.call('b3.supervision.getAgentUsage', { agentId: target }),
    ), describeUsage);
  },

  async interrupt(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent.interrupt', argFlags, '<agentRunId>');
    emit('agent.interrupt', argFlags, await withClient(async (client) => {
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
      return usage('agent.stop', argFlags, '<agentId> --run <agentRunId> --confirm stop-one');
    }
    emit('agent.stop', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.stop', {
        agentId, expectedLiveRunId: agentRunId, confirmation: 'stop-one',
      }, operationId()),
    ), (view) => `Stopped ${view.agent.displayName}. Its children keep running; `
      + 'their supervision moved to the nearest live ancestor.');
  },

  /**
   * The two halves of §17.1's two-step stop are two members of X-1's set, not
   * one: `prepare` mints a confirmation token and changes nothing, `confirm`
   * stops a family. A single `command` for both would leave a reader of the
   * record unable to tell a rehearsal from the real thing.
   */
  'stop-tree': async (argFlags) => {
    const preparing = argFlags.value('prepare') !== undefined;
    const rootAgentId = argFlags.positional[0];
    if (!rootAgentId) {
      return usage(preparing ? 'agent.stop-tree.prepare' : 'agent.stop-tree.confirm', argFlags,
        '<agentId> --prepare | --token <t> --confirm stop-tree');
    }
    if (preparing) {
      return emit('agent.stop-tree.prepare', argFlags, await withClient<StopTreeConfirmation>(
        (client) => client.call('b3.agent.prepareStopTree', { rootAgentId }, operationId()),
      ), (confirmation) => `This will stop ${confirmation.visibleDescendantCount} agent(s) `
        + `below ${confirmation.rootAgentId}, and that agent.\n`
        + `To go ahead: nvk-agent stop-tree ${confirmation.rootAgentId} `
        + `--token ${confirmation.confirmationToken} --confirm stop-tree`);
    }
    const token = argFlags.value('token');
    if (!token || argFlags.value('confirm') !== 'stop-tree') {
      return usage('agent.stop-tree.confirm', argFlags, '<agentId> --token <t> --confirm stop-tree');
    }
    return emit('agent.stop-tree.confirm', argFlags, await withClient<RunOperationView>(
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
      return usage('agent.continue', argFlags,
        '<agentId> --from <agentRunId> --mode resume|fresh|compact|handover [--config inherit-plan|refresh-role]');
    }
    emit('agent.continue', argFlags, await withClient<AgentRunView>(
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
      return usage('agent.adopt', argFlags,
        '<agentId> --supervisor <agentId|human:<principal>> --expect <generation>');
    }
    emit('agent.adopt', argFlags, await withClient<SupervisionAssignment>(
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
    if (!agentRunId) return usage('agent.attach', argFlags, '<agentRunId>');
    emit('agent.attach', argFlags, await withClient<AgentRunView>(
      (client) => client.call('b3.agent.getRun', { agentRunId }),
    ), (view) => (view.run.terminalSessionId === undefined
      ? `${view.agent.displayName} has no terminal yet (${view.run.lifecycle}).`
      : `${view.agent.displayName} is on ${view.run.terminalSessionId}.\n`
        + `  Watch it:  nvk-terminal read ${view.run.terminalSessionId}\n`
        + `  Type into it:  nvk-terminal attach ${view.run.terminalSessionId}`));
  },

  async controls(argFlags) {
    const agentRunId = argFlags.positional[0];
    if (!agentRunId) return usage('agent.controls', argFlags, '<agentRunId>');
    emit('agent.controls', argFlags, await withClient<ControlCapabilityFacts>(
      (client) => client.call('b3.agent.controls', { agentRunId }),
    ), describeControls);
  },

  async control(argFlags) {
    const agentRunId = argFlags.positional[0];
    const setting = argFlags.value('set');
    const separator = setting?.indexOf('=') ?? -1;
    if (!agentRunId || setting === undefined || separator <= 0) {
      return usage('agent.control', argFlags, '<agentRunId> --set model|effort|provider-setting=<value>');
    }
    emit('agent.control', argFlags, await withClient<AgentControlOutcomeFacts>(async (client) => {
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

  // §17.1's message/communications verbs. `personId` is how Messaging names
  // the human at this keyboard; it is derived from the same principal the
  // socket authenticates, never taken from a flag (red gate 5).
  ...messageCommands({
    withClient, emit, usage, fail, operationId,
    personId: `person_${(process.env['NOVAKAI_PRINCIPAL'] ?? 'chris').replace(/[^A-Za-z0-9-]/gu, '-')}`,
  }),

  async operations(argFlags) {
    emit('agent operations', argFlags, await withClient<readonly RunOperationView[]>(
      (client) => client.call('b3.agent.listOperations', {}),
    ), (found) => (found.length === 0
      ? 'No operations recorded.'
      : found.map((item) => `${item.operation.kindOfOperation}  ${item.operation.state}  `
        + `${item.operation.currentStage}  ${item.operation.id}`).join('\n')));
  },
};

/**
 * X-1's member for a verb, resolved from the SAME facts the handler resolves
 * from, so a refusal issued before dispatch names the command the operator
 * actually typed rather than its group. The dual forms are spelled here too;
 * `b3e-cli-command.test.ts` drives every command down both paths and asserts
 * they agree, because two spellings of one answer is how they drift.
 */
function commandOf(name: string, argFlags: Flags): CliCommand | undefined {
  const target = argFlags.positional[0];
  if (name === 'inspect') return isRunForm(target) ? 'agent.inspect.run' : 'agent.inspect.agent';
  if (name === 'usage') return isRunForm(target) ? 'agent.usage.run' : 'agent.usage.agent';
  if (name === 'stop-tree') {
    return argFlags.value('prepare') === undefined
      ? 'agent.stop-tree.confirm' : 'agent.stop-tree.prepare';
  }
  return AGENT_COMMANDS[name];
}

/** Every single-form verb, ruled and unruled alike. */
const AGENT_COMMANDS: Readonly<Record<string, CliCommand>> = {
  spawn: 'agent.spawn', list: 'agent.list', tree: 'agent.tree', attach: 'agent.attach',
  interrupt: 'agent.interrupt', stop: 'agent.stop', continue: 'agent.continue',
  adopt: 'agent.adopt', controls: 'agent.controls', control: 'agent.control',
  message: 'agent.message', communications: 'agent.communications', events: 'agent.events',
  // Outside §17.1's tree; a ruling is owed (NVK-KIMI-090 handover §3 item 3).
  roles: 'agent roles', 'define-role': 'agent define-role', operations: 'agent operations',
  fence: 'agent fence', grants: 'agent grants', repair: 'agent repair',
  'open-conversation': 'agent open-conversation',
};

async function runCommand(name: string, argFlags: Flags): Promise<never> {
  const command = commandOf(name, argFlags);
  if (command === undefined || COMMANDS[name] === undefined) {
    // Derived from the table, so a verb added without a usage line is
    // impossible rather than merely unlikely.
    return usage('agent', argFlags, Object.keys(COMMANDS).join('|'));
  }
  if (!mintedOperationId.ok) return fail(command, argFlags, mintedOperationId.error);
  return COMMANDS[name]!(argFlags);
}

function usage(command: CliCommand, argFlags: Flags, expected: string): never {
  emit(command, argFlags, b3fail(
    b3err('ValidationFailed', `usage: nvk-agent ${verbOf(command)} ${expected}`,
      { issues: [{ path: 'argv', message: `expected ${expected}` }] }, false),
  ), () => '');
}

await runCommand(command, flags);
