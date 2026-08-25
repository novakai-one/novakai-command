// `nvk agent message` and `nvk agent communications` (§17.1, §17.2).
//
// Both are in §17.1's canonical command list and neither existed. That is not
// a cosmetic gap: §17.1 is the scriptable surface, and "Chris watches two
// agents talk, then opens their conversation deliberately" is a §25-B3c exit
// promise that had no command behind it.
//
// Neither resolves a Thread for the caller. §12.5 requires a `threadId`, and
// A5-07 rules that the operator supplies it (`--thread <threadId>`, required):
// until then this file MINTED one through `ensureDirectThread` whenever the
// flag was absent, so sending one line created a durable conversation as a
// side effect. Minting is still one published operation away — it is just no
// longer something a send does behind your back.
import type {
  B3ClientOpId, B3ContractError, B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentCommunicationItem, AgentDeliveryInstruction, ConversationView, MessageAcceptance,
} from '../../messaging/contract/index.js';
import type { RuntimeClient } from '../core/b3/client.js';
import { pageFlags, type CliCommand, type Flags } from '../core/b3/cli-shared.js';

export interface MessageDeps {
  withClient<Value>(
    work: (client: RuntimeClient) => Promise<B3Result<Value>>,
  ): Promise<B3Result<Value>>;
  emit<Value>(
    command: CliCommand, argFlags: Flags, result: B3Result<Value>, human: (value: Value) => string,
  ): never;
  usage(command: CliCommand, argFlags: Flags, expected: string): never;
  /** Refuse before dispatch, naming the command that was typed (X-1). */
  fail(command: CliCommand, argFlags: Flags, error: B3ContractError): never;
  operationId(): B3ClientOpId;
}

interface Page<T> { readonly items: readonly T[] }

const isRun = (target: string): boolean => target.startsWith('agentRun_');

/**
 * §17.2 wants human output that states truth rather than implying it. A queued
 * Message has NOT reached the agent — saying "sent" would be the kind of small
 * lie that makes someone stop trusting the tool.
 */
type MessageCommandResult = MessageAcceptance | AgentDeliveryInstruction;

function describeAcceptance(acceptance: MessageCommandResult): string {
  if ('kind' in acceptance) {
    return `${acceptance.transcriptMarker}\nAddressed delivery recorded for transcript ingestion.`;
  }
  const state = {
    'committed': 'committed (no delivery was required)',
    'queued-for-agent': 'accepted and queued — the agent has not read it yet',
    'submitted-confirmed': 'delivered to the agent\'s terminal',
    'submitted-unconfirmed': 'typed into the terminal, but the provider never confirmed reading it',
  }[acceptance.state];
  const repeat = acceptance.duplicate ? '\nThis was a repeat of a Message already accepted.' : '';
  return `Message ${acceptance.messageId} in thread ${acceptance.threadId}\n${state}${repeat}`;
}

function describeCommunications(page: Page<AgentCommunicationItem>): string {
  if (page.items.length === 0) return 'No Messages involve those Agents yet.';
  return page.items.map((item) => {
    const arrow = {
      'to-agent': '→', 'from-agent': '←', 'between-agents': '↔',
    }[item.direction];
    const mirrored = item.originBindingId === undefined ? '' : '  (mirrored from the terminal)';
    return `${item.occurredAt}  ${arrow}  ${item.senderPrincipalId}${mirrored}\n  ${item.textPreview}`;
  }).join('\n');
}

export function messageCommands(
  deps: MessageDeps,
): Record<string, (argFlags: Flags) => Promise<never>> {
  const { withClient, emit, usage, fail } = deps;

  return {
    /**
     * A5-07: `nvk agent message <agentId|agentRunId> --thread <threadId>
     * --text <text>`. All three are required — the amendment brackets none of
     * them, and it is the ruled answer to OQ-11 ("thread selection/creation for
     * a CLI-originated Message is undefined").
     *
     * It used to MINT one when the flag was absent, so sending a line created a
     * durable conversation as a side effect. Messaging publishes
     * `ensureDirectThread` so that minting is something a caller asks for on
     * purpose; the CLI's job here is to carry the operator's choice, not to
     * make it for them.
     *
     * An `agentRun_` target is an EXACT-RUN send: it names the provider context
     * that must read it, and it fails rather than silently redirecting once
     * that Run's endpoint has closed (§8.1).
     */
    async message(argFlags) {
      const target = argFlags.positional[0];
      const text = argFlags.value('text');
      const threadId = argFlags.value('thread');
      if (target === undefined || text === undefined || threadId === undefined) {
        return usage('agent.message', argFlags,
          '<agentId|agentRunId> --thread <threadId> --text <text>');
      }
      return emit('agent.message', argFlags, await withClient<MessageCommandResult>(
        async (client) => {
          return client.call<MessageCommandResult>('b3.messaging.sendAgent', {
            target: isRun(target)
              ? { kind: 'exact-run', agentRunId: target }
              : { kind: 'agent', agentId: target },
            threadId,
            text,
            ...(argFlags.value('client-op-id') === undefined
              ? {} : { clientMessageId: argFlags.value('client-op-id') }),
          });
        },
      ), describeAcceptance);
    },

    /**
     * `nvk agent communications <agentId> [--with <agentId>]`.
     *
     * §19.2's inspection, and it PINS NOTHING: reading is a read. The
     * conversation only appears in Chris's sidebar when he opens it.
     */
    async communications(argFlags) {
      const agentId = argFlags.positional[0];
      if (agentId === undefined) {
        return usage('agent.communications', argFlags, '<agentId> [--with <agentId>]');
      }
      const withAgent = argFlags.value('with');
      // A5-01's flags, through the one shared parser: the CLI hands `limit`
      // and `cursor` to the list method unchanged and never re-pages.
      const page = pageFlags(argFlags);
      if (!page.ok) return fail('agent.communications', argFlags, page.error);
      return emit('agent.communications', argFlags,
        await withClient<Page<AgentCommunicationItem>>(
          (client) => client.call('b3.messaging.listAgentCommunications', {
            agentIds: withAgent === undefined ? [agentId] : [agentId, withAgent],
            ...page.value,
          }),
        ), describeCommunications);
    },

    /**
     * `nvk agent open-conversation <threadId> --with <agentId>` — the
     * deliberate act §19.2 keeps separate from inspection.
     */
    async ['open-conversation'](argFlags) {
      const threadId = argFlags.positional[0];
      const withAgent = argFlags.value('with');
      if (threadId === undefined || withAgent === undefined) {
        return usage('agent open-conversation', argFlags, '<threadId> --with <agentId>');
      }
      // `--with a,b` opens a GROUP conversation. Comma-separated because a
      // group is a set and the shell has no list type; one id is a direct.
      const group = withAgent.split(',').map((entry) => entry.trim()).filter(Boolean);
      return emit('agent open-conversation', argFlags, await withClient<ConversationView>(
        (client) => client.call('b3.messaging.openConversation', {
          threadId,
          membership: group.length > 1
            ? { kind: 'group', agentIds: group }
            : { kind: 'direct', agentId: group[0] ?? withAgent },
        }),
      ), (view) => `Conversation ${view.threadId} is now open in Messages (${view.membershipKind}).`);
    },
  };
}
