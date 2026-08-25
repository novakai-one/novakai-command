import { createHash } from 'node:crypto';
import type { ConversationSendInput } from '../../contract/commands.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type {
  ConversationId,
  ProviderSessionId,
  RequestHash,
  SendId,
  Timestamp,
} from '../../contract/types.js';

interface AcceptDependencies {
  readonly store: TranscriptStore;
  readonly agentDirectory: AgentDirectory;
  readonly now: () => string;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const validate = (input: ConversationSendInput): void => {
  if (!/^conv_[A-Za-z0-9-]{4,64}$/.test(input.conversationId)) {
    throw new Error('Conversation send requires a valid conversationId');
  }
  if (input.issuedBy.length === 0 || input.targetAgentId.length === 0) {
    throw new Error('Conversation send requires issuer and target Agent');
  }
  if (input.clientOpId.length === 0 || input.clientOpId.length > 128) {
    throw new Error('Conversation send requires a bounded clientOpId');
  }
  if (input.text.trim().length === 0 || Buffer.byteLength(input.text, 'utf8') > 32_768) {
    throw new Error('Conversation message text must contain 1..32768 UTF-8 bytes');
  }
};

/** Persist one idempotent accepted request before provider execution. */
export async function acceptSend(
  dependencies: AcceptDependencies,
  input: ConversationSendInput,
): Promise<{ readonly journal: SendJournal; readonly duplicate: boolean }> {
  validate(input);
  const agent = await dependencies.agentDirectory.get(input.targetAgentId);
  if (agent === null) throw new Error(`Unknown target Agent ${input.targetAgentId}`);
  const request = {
    text: input.text,
    ...(input.screenContext === undefined ? {} : { screenContext: input.screenContext }),
  };
  const requestHash = hash(canonical({
    conversationId: input.conversationId,
    issuedBy: input.issuedBy,
    targetAgentId: input.targetAgentId,
    request,
  })) as RequestHash;
  const id = `send_${hash(`${input.issuedBy}:${input.clientOpId}`)}` as SendId;
  const timestamp = dependencies.now() as Timestamp;
  const journal: SendJournal = {
    id,
    kind: 'send-journal',
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    conversationId: input.conversationId as ConversationId,
    issuedBy: input.issuedBy,
    targetAgentId: input.targetAgentId,
    clientOpId: input.clientOpId,
    request,
    requestHash,
    state: 'accepted',
    attempts: [],
    ...(agent.currentProviderSessionId === null
      ? {} : { targetSessionId: agent.currentProviderSessionId as ProviderSessionId }),
  };
  return dependencies.store.acceptSend({ journal });
}
