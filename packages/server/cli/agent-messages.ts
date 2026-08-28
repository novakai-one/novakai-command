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
  B3ContractError, B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentCommunicationView, AgentDeliveryInstruction,
} from '../../messaging/contract/index.js';
import type { RuntimeClient } from '../core/runtime-host/client.js';
import { pageFlags, type CliCommand, type Flags } from '../core/runtime-host/cli-shared.js';

interface MessageDeps {
  withClient<Value>(
    work: (client: RuntimeClient) => Promise<B3Result<Value>>,
  ): Promise<B3Result<Value>>;
  emit<Value>(
    command: CliCommand, argFlags: Flags, result: B3Result<Value>, human: (value: Value) => string,
  ): never;
  usage(command: CliCommand, argFlags: Flags, expected: string): never;
  /** Refuse before dispatch, naming the command that was typed (X-1). */
  fail(command: CliCommand, argFlags: Flags, error: B3ContractError): never;
}

interface Page<T> { readonly items: readonly T[] }

/**
 * §17.2 wants human output that states truth rather than implying it. A queued
 * Message has NOT reached the agent — saying "sent" would be the kind of small
 * lie that makes someone stop trusting the tool.
 */
interface SendResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly state: string;
  readonly duplicate: boolean;
}

type MessageCommandResult = SendResult | AgentDeliveryInstruction;
type CommandHandler = (argFlags: Flags) => Promise<never>;

function describeAcceptance(acceptance: MessageCommandResult): string {
  if ('kind' in acceptance) {
    return `${acceptance.transcriptMarker}\nAddressed delivery recorded for transcript ingestion.`;
  }
  const state = acceptance.state.replaceAll('-', ' ');
  const repeat = acceptance.duplicate ? '\nThis was a repeat of a Message already accepted.' : '';
  return `Message ${acceptance.messageId} in thread ${acceptance.threadId}\n${state}${repeat}`;
}

function describeCommunications(page: Page<AgentCommunicationView>): string {
  if (page.items.length === 0) return 'No Messages involve those Agents yet.';
  return page.items.map((item) => {
    const arrow = {
      'to-agent': '→', 'from-agent': '←', 'between-agents': '↔',
    }[item.direction];
    const mirrored = item.originBindingId === undefined ? '' : '  (mirrored from the terminal)';
    return `${item.occurredAt}  ${arrow}  ${item.senderPrincipalId}${mirrored}\n  ${item.textPreview}`;
  }).join('\n');
}

/** Send through Messaging; it resolves the Agent's current ProviderSession. */
async function sendMessage(deps: MessageDeps, argFlags: Flags): Promise<never> {
  const target = argFlags.positional[0];
  const text = argFlags.value('text');
  const threadId = argFlags.value('thread');
  if (target === undefined || text === undefined || threadId === undefined) {
    return deps.usage('agent.message', argFlags, '<agentId> --thread <threadId> --text <text>');
  }
  const result = await deps.withClient<MessageCommandResult>((client) =>
    client.call<MessageCommandResult>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: target },
      threadId,
      text,
      ...(argFlags.value('client-op-id') === undefined
        ? {} : { clientMessageId: argFlags.value('client-op-id') }),
    }));
  return deps.emit('agent.message', argFlags, result, describeAcceptance);
}

/** Inspect Agent communications without creating or pinning a View. */
async function listCommunications(deps: MessageDeps, argFlags: Flags): Promise<never> {
  const agentId = argFlags.positional[0];
  if (agentId === undefined) {
    return deps.usage('agent.communications', argFlags, '<agentId> [--with <agentId>]');
  }
  const withAgent = argFlags.value('with');
  const page = pageFlags(argFlags);
  if (!page.ok) return deps.fail('agent.communications', argFlags, page.error);
  const result = await deps.withClient<Page<AgentCommunicationView>>((client) =>
    client.call('b3.messaging.listAgentCommunications', {
      agentIds: withAgent === undefined ? [agentId] : [agentId, withAgent],
      ...page.value,
    }));
  return deps.emit('agent.communications', argFlags, result, describeCommunications);
}

interface OpenedConversation {
  readonly threadId: string;
  readonly conversationId: string;
}

/** Deliberately open one direct or group conversation in the Messages UI. */
async function openConversation(deps: MessageDeps, argFlags: Flags): Promise<never> {
  const threadId = argFlags.positional[0];
  const withAgent = argFlags.value('with');
  if (threadId === undefined || withAgent === undefined) {
    return deps.usage('agent open-conversation', argFlags, '<threadId> --with <agentId>');
  }
  const group = withAgent.split(',').map((entry) => entry.trim()).filter(Boolean);
  const result = await deps.withClient<OpenedConversation>((client) =>
    client.call('b3.messaging.openConversation', {
      threadId,
      membership: group.length > 1
        ? { kind: 'group', agentIds: group }
        : { kind: 'direct', agentId: group[0] ?? withAgent },
    }));
  return deps.emit('agent open-conversation', argFlags, result,
    (view) => `Conversation ${view.threadId} is now open in Messages.`);
}

/** Build the three transcript-first Agent messaging CLI handlers. */
export function messageCommands(deps: MessageDeps): Record<string, CommandHandler> {
  return {
    message: (flags) => sendMessage(deps, flags),
    communications: (flags) => listCommunications(deps, flags),
    'open-conversation': (flags) => openConversation(deps, flags),
  };
}
