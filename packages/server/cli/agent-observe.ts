// The reads an operator makes ABOUT the machine, rather than commands aimed at
// one Agent: the event stream (§17.1 `nvk agent events`), the tree-closing
// fence, the delegation grants, and §20's repair.
//
// They live beside `nvk-agent.ts` rather than inside it because they share
// nothing with the lifecycle verbs but the connection — and because a file that
// grows a verb per surface stops being readable long before it stops compiling.
import type { B3ClientOpId, B3Result } from '@novakai/foundation/contract';
import type {
  RunEventPage, RunOperationView, TreeMutationFence,
} from '../../agent-runtime/contract/index.js';
import type { DelegationGrant } from '../../agents/b3/contract/index.js';
import type { RuntimeClient } from '../core/b3/client.js';
import type { CliCommand, Flags } from '../core/b3/cli-shared.js';

export interface ObserveDeps {
  withClient<Value>(
    work: (client: RuntimeClient) => Promise<B3Result<Value>>,
  ): Promise<B3Result<Value>>;
  emit<Value>(
    command: CliCommand, argFlags: Flags, result: B3Result<Value>, human: (value: Value) => string,
  ): never;
  usage(command: CliCommand, argFlags: Flags, expected: string): never;
  operationId(): B3ClientOpId;
}

/** The verb table `nvk-agent` spreads into its own. */
export function observeCommands(
  deps: ObserveDeps,
): Record<string, (argFlags: Flags) => Promise<never>> {
  const { withClient, emit, usage, operationId } = deps;
  return {
  /**
   * §17.1: `nvk agent events [--after <cursor>]`. It is in the canonical
   * command list and it did not exist, so the stream was reachable only by
   * someone willing to write a WebSocket client.
   */
  async events(argFlags) {
    const after = argFlags.value('after');
    return emit('agent.events', argFlags, await withClient<RunEventPage>(
      (client) => client.call('b3.agent.subscribeEvents', {
        ...(after === undefined ? {} : { after }),
        limit: Number(argFlags.value('limit') ?? '50'),
      }),
    ), (page) => (page.events.length === 0
      ? `Nothing since that cursor. Resume from ${page.nextCursor}.`
      : `${page.events.map((event) => `${event.occurredAt}  ${event.kind}`).join('\n')}\n`
        + `Resume from ${page.nextCursor}.`));
  },

  /** Whether a stop is freezing this Agent's family right now (§13.7). */
  async fence(argFlags) {
    const agentId = argFlags.value('agent') ?? argFlags.positional[0];
    if (!agentId) return usage('agent fence', argFlags, '<agentId>');
    return emit('agent fence', argFlags, await withClient<TreeMutationFence | null>(
      (client) => client.call('b3.agent.getTreeFence', { agentId }),
    ), (fence) => (fence === null
      ? 'Nothing is stopping that family.'
      : `That family is ${fence.state} under operation ${fence.operationId}.\n`
        + `  Resume it:  nvk agent repair ${fence.operationId}`));
  },

  /** §20's recovery action for an operation an earlier attempt left open. */
  async repair(argFlags) {
    const stranded = argFlags.positional[0];
    if (!stranded) return usage('agent repair', argFlags, '<operationId>');
    return emit('agent repair', argFlags, await withClient<RunOperationView>(
      (client) => client.call('b3.agent.repairOperation',
        { operationId: stranded }, operationId()),
    ), (view) => `${view.operation.kindOfOperation} is now ${view.operation.state}.`);
  },

  async grants(argFlags) {
    const holder = argFlags.value('holder');
    return emit('agent grants', argFlags, await withClient<readonly DelegationGrant[]>(
      (client) => client.call('b3.agent.listGrants',
        holder === undefined ? {} : { holderAgentRunId: holder }),
    ), (found) => (found.length === 0
      ? 'No active grants.'
      : found.map((grant) => `${grant.id}\n  held by ${grant.issuerAgentRunId}`
        + ` · over ${grant.targetAgentIds.length} agent(s) · ${grant.scopes.join(', ')}`).join('\n')));
  },

  };
}
